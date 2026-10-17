import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ExpertiseArea } from "@/config/brand";
import { createAuditContext } from "@/core/context";
import { mapLimit } from "@/core/concurrency";
import type { Finding } from "@/core/types";
import { normalizeTargetUrl } from "@/core/url-guard";
import { expertHelpDetails, expertRecommendation } from "@/decision/recommend";
import { whyPlanning } from "@/analysis/deep-audit";
import { nextAfterFixes } from "@/funnel/stages";
import {
  INDEXATION_CODES,
  pathKey,
  verifyIssues,
  type IndexInspection,
  type PageAnalyticsMetrics,
  type PageSearchMetrics,
  type VerificationData,
} from "@/decision/verify";
import { prepareFixes } from "@/fixes/plan";
import { stageFixes } from "@/approvals/stage";
import { loadSite } from "@/platforms/connections";
import { getAccessToken } from "@/integrations/google/connections";
import { recentRange } from "@/integrations/google/dates";
import { pageReport } from "@/integrations/google/ga4";
import { inspectUrl, searchAnalytics } from "@/integrations/google/gsc";
import { resolveGscProperty } from "@/integrations/google/site-data";
import { getIssueDefinition, listIssueDefinitions } from "@/policy/catalog";
import { classify } from "@/policy/classify";
import { TIERS } from "@/policy/tiers";
import { formatFixes, formatStaged, formatVerification } from "../format";
import { failure, guard, text } from "../respond";
import { auditIdField, connectionIdField, gscPropertyField, issueRefField, urlField } from "../schemas";

const MAX_INSPECTIONS = 5;

function sameSite(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

export function registerDecisionTools(server: McpServer): void {
  server.registerTool(
    "verify_issues_with_data",
    {
      title: "Verify issues with Search Console and GA4",
      description:
        "Checks audit issues against real data to show which ones actually affect search visibility, traffic, engagement or conversions. Uses Search Console page metrics (current vs previous period), URL inspection for indexation/canonical issues, and GA4 page metrics when a propertyId is given. Returns issues sorted by priority with the evidence.",
      inputSchema: z.object({
        connectionId: connectionIdField,
        siteUrl: urlField,
        issues: z.array(issueRefField).min(1).max(40).describe("Issues from audit results (code and url)"),
        gscProperty: gscPropertyField,
        ga4PropertyId: z.string().regex(/^\d+$/).optional().describe("Numeric GA4 property ID (from ga4_list_properties)"),
        days: z.number().int().min(7).max(90).optional().describe("Period length in days (default 28)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ connectionId, siteUrl, issues, gscProperty, ga4PropertyId, days }) => {
      const unknown = issues.filter((issue) => !getIssueDefinition(issue.code));
      if (unknown.length === issues.length) return failure("None of the issue codes are recognized. Use codes exactly as shown in audit results.");
      const site = normalizeTargetUrl(siteUrl).toString();
      const accessToken = await getAccessToken(connectionId);
      const period = days ?? 28;
      const notes: string[] = [];
      const data: VerificationData = {
        search: new Map<string, PageSearchMetrics>(),
        analytics: new Map<string, PageAnalyticsMetrics>(),
        inspections: new Map<string, IndexInspection>(),
        keyEventsTracked: false,
        hasSearchData: false,
        hasAnalyticsData: false,
      };

      let property: string | undefined;
      try {
        property = await resolveGscProperty(accessToken, site, gscProperty);
      } catch (error) {
        notes.push((error as Error).message);
      }

      const current = recentRange(period);
      if (property) {
        const previous = recentRange(period, 3, period);
        const [now, before] = await Promise.all([
          searchAnalytics(accessToken, property, { ...current, dimensions: ["page"], rowLimit: 5000 }),
          searchAnalytics(accessToken, property, { ...previous, dimensions: ["page"], rowLimit: 5000 }),
        ]);
        const previousByPath = new Map(before.filter((row) => sameSite(row.keys[0] ?? "", site)).map((row) => [pathKey(row.keys[0] ?? ""), row]));
        for (const row of now) {
          const page = row.keys[0] ?? "";
          if (!sameSite(page, site)) continue;
          const prior = previousByPath.get(pathKey(page));
          data.search.set(pathKey(page), {
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
            ...(prior ? { previous: { clicks: prior.clicks, impressions: prior.impressions } } : {}),
          });
        }
        data.hasSearchData = data.search.size > 0;
        if (!data.hasSearchData) notes.push("Search Console has no page data for this site in the period.");

        const toInspect = [...new Set(issues.filter((issue) => INDEXATION_CODES.has(issue.code)).map((issue) => issue.url))].slice(0, MAX_INSPECTIONS);
        await mapLimit(toInspect, 2, async (url) => {
          try {
            data.inspections.set(url, await inspectUrl(accessToken, property!, url));
          } catch (error) {
            notes.push(`URL inspection failed for ${url}: ${(error as Error).message}`);
          }
        });
      }

      if (ga4PropertyId) {
        try {
          const rows = await pageReport(accessToken, ga4PropertyId, { ...recentRange(period, 1), limit: 2000 });
          for (const row of rows) {
            const key = pathKey(row.path);
            const existing = data.analytics.get(key);
            data.analytics.set(key, {
              sessions: (existing?.sessions ?? 0) + row.sessions,
              engagementRate: row.engagementRate,
              keyEvents: (existing?.keyEvents ?? 0) + row.keyEvents,
            });
          }
          data.hasAnalyticsData = rows.length > 0;
          data.keyEventsTracked = rows.some((row) => row.keyEvents > 0);
          if (!data.keyEventsTracked) notes.push("GA4 recorded no key events, so conversions cannot be measured. Mark form submits, calls or purchases as key events in GA4.");
        } catch (error) {
          notes.push(`GA4 data could not be loaded: ${(error as Error).message}`);
        }
      } else {
        notes.push("No GA4 property given; conversion and engagement checks used Search Console only. Use ga4_list_properties to find the ID.");
      }

      if (unknown.length) notes.push(`Skipped unrecognized codes: ${unknown.map((issue) => issue.code).join(", ")}`);
      const known = issues.filter((issue) => getIssueDefinition(issue.code));
      const verified = verifyIssues(known, data);
      const classified = classify(known.map((issue): Finding => ({ code: issue.code, url: issue.url })));
      return text(
        formatVerification(
          verified,
          {
            ...(property ? { property } : {}),
            ...(ga4PropertyId ? { ga4PropertyId } : {}),
            period: `${current.startDate} to ${current.endDate}`,
            notes,
          },
          expertRecommendation(classified, verified),
        ),
      );
    }),
  );

  server.registerTool(
    "prepare_fixes",
    {
      title: "Prepare fixes (nothing is published without approval)",
      description:
        "ASK THE USER BEFORE CALLING. Prepares fixes for audit issues and enforces the change policy: 🟢 minor content issues (titles, meta descriptions, image alt text, broken links, tap-to-call) get exact changes; 🟡 medium issues return a proposal unless their code is in approvedCodes (include a code ONLY after the user explicitly approved it), then a draft; 🔴 issues (high-risk, or needing plugins, code snippets, theme or server changes) are never prepared and return an expert warning. With siteConnectionId (from connect_website), the minor fixes are staged on a private approval page: nothing is published until the site owner opens the link and clicks Approve. Without it, the fixes are returned for manual application.",
      inputSchema: z.object({
        issues: z.array(issueRefField).min(1).max(30),
        approvedCodes: z.array(z.string().max(100)).max(30).optional().describe("Medium-tier issue codes the user explicitly approved"),
        siteConnectionId: z
          .string()
          .min(10)
          .max(200)
          .optional()
          .describe("Website connection ID from connect_website, to stage fixes for owner approval and publishing"),
        altText: z
          .array(z.object({ src: z.string().max(2048), alt: z.string().min(1).max(250) }))
          .max(30)
          .optional()
          .describe("Better alt text you wrote after looking at the images (image URL and alt text)"),
        platform: z
          .enum(["html", "wordpress", "shopify", "wix", "squarespace", "webflow", "other"])
          .optional()
          .describe("Website platform, for manual where-to-apply instructions (ask the user if unknown)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ issues, approvedCodes, siteConnectionId, altText, platform }) => {
      const results = await prepareFixes(createAuditContext(), issues, {
        ...(approvedCodes ? { approvedCodes } : {}),
        ...(platform ? { platform } : {}),
        ...(altText ? { altText } : {}),
      });
      if (!siteConnectionId) {
        const hasPublishable = results.some((result) => result.outcome.status === "ready");
        return text(
          formatFixes(results) +
            (hasPublishable
              ? "\n\nTo apply these: call get_fix_plan to see how to connect this site's platform. WordPress sites can be connected with connect_website so the owner approves each change before it is published."
              : "") +
            nextAfterFixes(false),
        );
      }
      const site = await loadSite(siteConnectionId);
      const staged = await stageFixes(results, site);
      return text(formatStaged(results, staged) + nextAfterFixes(false));
    }),
  );

  server.registerTool(
    "list_issue_types",
    {
      title: "List issue types and risk tiers",
      description: "Lists every issue the audits can report with its risk tier and whether it can be fixed automatically. Use to explain the policy or look up a code.",
      inputSchema: z.object({
        category: auditIdField.optional(),
        tier: z.enum(["safe", "medium", "high"]).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ category, tier }) => {
      const definitions = listIssueDefinitions().filter(
        (definition) => (!category || definition.category === category) && (!tier || definition.tier === tier),
      );
      const policy = Object.values(TIERS).map((definition) => `- ${definition.emoji} **${definition.label}**: ${definition.description}`);
      const rows = definitions.map((definition) => `| ${TIERS[definition.tier].emoji} | \`${definition.code}\` | ${definition.title} | ${definition.impact} |`);
      return text(["## Change policy", ...policy, "", "| Tier | Code | Issue | Impact |", "|---|---|---|---|", ...rows].join("\n"));
    }),
  );

  server.registerTool(
    "connect_with_expert",
    {
      title: "Connect with an Incrementors Expert",
      description:
        "FINAL FUNNEL STAGE. Use when the audit found strategic/expert work (🔴) and the user wants help, or asks about professional help. Returns the booking link for a free strategy session with an Incrementors SEO/AEO/GEO strategist and a short, ready-to-send brief of the user's audit so the strategist starts with context. Never use it before the user has received their audit results.",
      inputSchema: z.object({
        siteUrl: urlField.optional(),
        area: z
          .enum(["seo", "technical-seo", "local-seo", "aeo", "geo", "content", "conversion", "web-development"] satisfies [ExpertiseArea, ...ExpertiseArea[]])
          .optional()
          .describe("Main area of help, if clear"),
        issueCodes: z.array(z.string().max(100)).max(20).optional().describe("Codes of the expert-level issues found"),
        overallScore: z.number().min(0).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ siteUrl, area, issueCodes, overallScore }) => {
      const definitions = (issueCodes ?? []).map((code) => getIssueDefinition(code)).filter((d): d is NonNullable<typeof d> => Boolean(d));
      const strategic = definitions.filter((d) => d.tier === "high");
      const details = expertHelpDetails(area ?? strategic[0]?.expertise ?? "seo");
      const brief = [
        `Website: ${siteUrl ?? "(your website)"}`,
        ...(overallScore !== undefined ? [`Audit score: ${overallScore}/100 (Incrementors Website Audit MCP)`] : []),
        ...(strategic.length ? ["Issues that need expert planning:", ...strategic.map((d) => `- ${d.title}: ${whyPlanning(d.code, d.expertReason)}`)] : []),
        ...(definitions.length > strategic.length ? [`Other open items: ${definitions.filter((d) => d.tier !== "high").map((d) => d.title).join("; ")}`] : []),
      ];
      return text(
        [
          "## Connect with an Incrementors Expert",
          `An Incrementors ${details.service} strategist can ${details.whatTheyDo}.`,
          "",
          `**→ Book a free 30-minute strategy session:** ${details.freeStrategySession}`,
          `Or get in touch: ${details.contact}`,
          "",
          "**Ready-to-send brief** (paste it into the booking form so the strategist starts with your audit):",
          "```",
          ...brief,
          "```",
          "",
          "This is optional. Everything in the audit stays yours, and the safe fixes and recommendations work without it.",
        ].join("\n"),
      );
    }),
  );
}
