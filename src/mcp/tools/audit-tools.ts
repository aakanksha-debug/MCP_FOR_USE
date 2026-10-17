import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  aeoAudit,
  contentOpportunityAudit,
  conversionAudit,
  gbpAudit,
  geoAudit,
  runFullAudit,
  schemaAudit,
  seoHealthAudit,
  technicalAudit,
} from "@/audits";
import { runAudit } from "@/audits/types";
import { createAuditContext } from "@/core/context";
import { QUESTION_QUERY, type SearchRow } from "@/core/search-data";
import { normalizeTargetUrl } from "@/core/url-guard";
import { expertRecommendation } from "@/decision/recommend";
import { pathKey } from "@/decision/verify";
import { loadSearchRows } from "@/integrations/google/site-data";
import { formatAuditResult, formatAuditSummary, formatFullAudit } from "../format";
import { guard, text } from "../respond";
import { auditIdField, gbpProfileField, gscPropertyField, optionalConnectionIdField, urlField } from "../schemas";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

/** Always offer Google sign-in after an audit unless the user already connected it. */
function offerGoogle(connectionId?: string): boolean {
  return !connectionId;
}

async function optionalSearchRows(connectionId: string | undefined, url: string, property: string | undefined) {
  if (!connectionId) return { rows: undefined as SearchRow[] | undefined, note: undefined as string | undefined };
  try {
    const data = await loadSearchRows(connectionId, url, property ? { property } : {});
    return { rows: data.rows, note: `Search Console data: ${data.property}, ${data.period} (${data.rows.length} rows).` };
  } catch (error) {
    return { rows: undefined, note: `Search Console data could not be loaded: ${(error as Error).message}` };
  }
}

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "seo_health_check",
    {
      title: "SEO Health Check",
      description:
        "Finds obvious on-page SEO problems across the homepage and a sample of internal pages: titles, meta descriptions, headings, image alt text, thin content, internal links, broken links, duplicate metadata, noindex and canonical issues.",
      inputSchema: z.object({
        url: urlField,
        maxPages: z.number().int().min(1).max(15).optional().describe("Pages to check including the start page (default 5)"),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ url, maxPages }) => {
      const result = await runAudit(seoHealthAudit, createAuditContext(), { url, ...(maxPages ? { maxPages } : {}) });
      return text(formatAuditResult(result, expertRecommendation(result.issues), offerGoogle()));
    }),
  );

  server.registerTool(
    "gbp_health_check",
    {
      title: "Google Business Profile Health Check",
      description:
        "Finds Google Business Profile optimization opportunities. Always checks the website's local signals (phone, address, LocalBusiness schema, map, profile link). If the user shares their profile details (name, categories, description, hours, photos, reviews, rating, replies, posts, services), also checks the profile itself. Ask the user for those details; never guess them.",
      inputSchema: z.object({ url: urlField, profile: gbpProfileField.optional() }),
      annotations: READ_ONLY,
    },
    guard(async ({ url, profile }) => {
      const result = await runAudit(gbpAudit, createAuditContext(), { url, ...(profile ? { profile } : {}) });
      return text(formatAuditResult(result, expertRecommendation(result.issues), offerGoogle()));
    }),
  );

  server.registerTool(
    "aeo_check",
    {
      title: "AEO Check (Answer Engine Optimization)",
      description:
        "Checks whether a page clearly answers common customer questions: question-style headings, short direct answers, FAQ markup, lists and readable paragraphs. Pass real customer questions to check coverage. With a Google connection, question searches from Search Console for this page are added automatically.",
      inputSchema: z.object({
        url: urlField,
        questions: z.array(z.string().min(3).max(300)).max(25).optional().describe("Questions customers ask about this topic"),
        googleConnectionId: optionalConnectionIdField,
        gscProperty: gscPropertyField,
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ url, questions, googleConnectionId, gscProperty }) => {
      const target = normalizeTargetUrl(url).toString();
      const allQuestions = [...(questions ?? [])];
      const search = await optionalSearchRows(googleConnectionId, target, gscProperty);
      if (search.rows) {
        const forPage = search.rows
          .filter((row) => pathKey(row.page) === pathKey(target) && QUESTION_QUERY.test(row.query))
          .sort((a, b) => b.impressions - a.impressions)
          .slice(0, 10)
          .map((row) => row.query);
        allQuestions.push(...forPage.filter((query) => !allQuestions.includes(query)));
      }
      const result = await runAudit(aeoAudit, createAuditContext(), { url: target, questions: allQuestions });
      if (search.note) result.notes.push(search.note);
      return text(formatAuditResult(result, expertRecommendation(result.issues), offerGoogle(googleConnectionId)));
    }),
  );

  server.registerTool(
    "geo_check",
    {
      title: "GEO Check (Generative Engine Optimization)",
      description:
        "Checks whether the brand and content are structured clearly for AI search systems (ChatGPT, Perplexity, Gemini, Claude, Google AI Overviews): AI crawler access in robots.txt, llms.txt, Organization markup and sameAs profiles, About page, consistent brand name, authorship, dates, evidence, a clear opening summary, and JavaScript-only rendering.",
      inputSchema: z.object({ url: urlField }),
      annotations: READ_ONLY,
    },
    guard(async ({ url }) => {
      const result = await runAudit(geoAudit, createAuditContext(), { url });
      return text(formatAuditResult(result, expertRecommendation(result.issues), offerGoogle()));
    }),
  );

  server.registerTool(
    "website_conversion_check",
    {
      title: "Website Conversion Check",
      description:
        "Checks whether visitors can quickly understand the business and contact it: headline clarity, calls to action and their placement, tap-to-call phone, contact form or email, contact page link, trust signals and form length.",
      inputSchema: z.object({ url: urlField }),
      annotations: READ_ONLY,
    },
    guard(async ({ url }) => {
      const result = await runAudit(conversionAudit, createAuditContext(), { url });
      return text(formatAuditResult(result, expertRecommendation(result.issues), offerGoogle()));
    }),
  );

  server.registerTool(
    "technical_website_check",
    {
      title: "Technical Website Check",
      description:
        "Finds obvious technical problems without changing anything: HTTP status, HTTPS and redirects, www duplication, robots.txt, XML sitemap, noindex, canonicals, viewport, language, mixed content, response time, compression, HSTS, image dimensions, hreflang and broken links. Optionally adds Core Web Vitals from Google PageSpeed Insights (slower).",
      inputSchema: z.object({
        url: urlField,
        includeCoreWebVitals: z.boolean().optional().describe("Also fetch Core Web Vitals from PageSpeed Insights (adds 10-30 seconds)"),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ url, includeCoreWebVitals }) => {
      const ctx = createAuditContext({ budgetMs: includeCoreWebVitals ? 55_000 : 45_000 });
      const result = await runAudit(technicalAudit, ctx, { url, includeCoreWebVitals: includeCoreWebVitals ?? false });
      return text(formatAuditResult(result, expertRecommendation(result.issues), offerGoogle()));
    }),
  );

  server.registerTool(
    "schema_check",
    {
      title: "Schema Check",
      description:
        "Identifies missing or potentially incorrect structured data (JSON-LD and microdata): invalid JSON, missing @context, missing required/recommended properties per type, missing Organization/WebSite on the homepage, and missing Breadcrumb, Article, Product or FAQ markup where the page content calls for it.",
      inputSchema: z.object({
        url: urlField,
        maxPages: z.number().int().min(1).max(10).optional().describe("Pages to check including the start page (default 3)"),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ url, maxPages }) => {
      const result = await runAudit(schemaAudit, createAuditContext(), { url, ...(maxPages ? { maxPages } : {}) });
      return text(formatAuditResult(result, expertRecommendation(result.issues), offerGoogle()));
    }),
  );

  server.registerTool(
    "content_opportunity_check",
    {
      title: "Content Opportunity Check",
      description:
        "Identifies a few high-value content gaps: missing key pages (About, Contact, FAQ, services, case studies, blog), thin service/location pages, stale blog, and pages missing for the business's priority topics. With a Google connection it adds Search Console opportunities: queries ranking 8-20, low click-through rate, question searches, cannibalization and specific queries landing only on the homepage.",
      inputSchema: z.object({
        url: urlField,
        maxPages: z.number().int().min(1).max(25).optional().describe("Pages to sample for depth (default 8)"),
        priorityTopics: z.array(z.string().min(2).max(120)).max(15).optional().describe("Services, products or locations that matter most"),
        googleConnectionId: optionalConnectionIdField,
        gscProperty: gscPropertyField,
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ url, maxPages, priorityTopics, googleConnectionId, gscProperty }) => {
      const target = normalizeTargetUrl(url).toString();
      const search = await optionalSearchRows(googleConnectionId, target, gscProperty);
      const result = await runAudit(contentOpportunityAudit, createAuditContext(), {
        url: target,
        ...(maxPages ? { maxPages } : {}),
        ...(priorityTopics ? { priorityTopics } : {}),
        ...(search.rows ? { searchRows: search.rows } : {}),
      });
      if (search.note) result.notes.push(search.note);
      return text(formatAuditResult(result, expertRecommendation(result.issues), offerGoogle(googleConnectionId)));
    }),
  );

  server.registerTool(
    "run_full_audit",
    {
      title: "Full Website Audit",
      description:
        "STAGE 1 of the funnel: the free website audit. Runs the checks (SEO, AEO, GEO, technical, schema, conversion, content, and Google Business Profile when the business is local) and returns the overall score, category scores and only the top findings, plus the next step. Use detail='full' only when the user asks to see every finding.",
      inputSchema: z.object({
        url: urlField,
        checks: z.array(auditIdField).max(8).optional().describe("Subset of checks to run; omit to run all"),
        questions: z.array(z.string().min(3).max(300)).max(25).optional(),
        priorityTopics: z.array(z.string().min(2).max(120)).max(15).optional(),
        gbpProfile: gbpProfileField.optional(),
        googleConnectionId: optionalConnectionIdField,
        gscProperty: gscPropertyField,
        detail: z.enum(["summary", "full"]).optional().describe("summary (default): scores and top findings; full: every finding"),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ url, checks, questions, priorityTopics, gbpProfile, googleConnectionId, gscProperty, detail }) => {
      const target = normalizeTargetUrl(url).toString();
      const search = await optionalSearchRows(googleConnectionId, target, gscProperty);
      const full = await runFullAudit(createAuditContext({ budgetMs: 50_000 }), {
        url: target,
        ...(checks ? { checks } : {}),
        ...(questions ? { questions } : {}),
        ...(priorityTopics ? { priorityTopics } : {}),
        ...(gbpProfile ? { gbpProfile } : {}),
        ...(search.rows ? { searchRows: search.rows } : {}),
      });
      if (search.note) full.results[0]?.notes.push(search.note);
      if (detail === "full") return text(formatFullAudit(full, expertRecommendation(full.issues), offerGoogle(googleConnectionId)));
      return text(formatAuditSummary(full, Boolean(googleConnectionId)));
    }),
  );
}
