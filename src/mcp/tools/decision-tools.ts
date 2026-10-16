import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ExpertiseArea } from "@/config/brand";
import { createAuditContext } from "@/core/context";
import { mapLimit } from "@/core/concurrency";
import type { Finding } from "@/core/types";
import { normalizeTargetUrl } from "@/core/url-guard";
import { expertHelpDetails, expertRecommendation } from "@/decision/recommend";
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
import { getAccessToken } from "@/integrations/google/connections";
import { recentRange } from "@/integrations/google/dates";
import { pageReport } from "@/integrations/google/ga4";
import { inspectUrl, searchAnalytics } from "@/integrations/google/gsc";
import { resolveGscProperty } from "@/integrations/google/site-data";
import { getIssueDefinition, listIssueDefinitions } from "@/policy/catalog";
import { classify } from "@/policy/classify";
import { TIERS } from "@/policy/tiers";
import { formatFixes, formatVerification } from "../format";
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
      title: "Prepare safe fixes",
      description:
        "Prepares fixes for audit issues without changing the website, enforcing the risk policy: 🟢 safe issues get exact ready-to-apply changes; 🟡 medium issues return a proposal unless their code is in approvedCodes (include a code ONLY after the user explicitly approved that change), in which case a draft is returned; 🔴 high-risk issues are never prepared and get an expert-review note.",
      inputSchema: z.object({
        issues: z.array(issueRefField).min(1).max(30),
        approvedCodes: z.array(z.string().max(100)).max(30).optional().describe("Medium-tier issue codes the user explicitly approved"),
        platform: z
          .enum(["html", "wordpress", "shopify", "wix", "squarespace", "webflow", "other"])
          .optional()
          .describe("Website platform, for where-to-apply instructions (ask the user if unknown)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ issues, approvedCodes, platform }) => {
      const results = await prepareFixes(createAuditContext(), issues, {
        ...(approvedCodes ? { approvedCodes } : {}),
        ...(platform ? { platform } : {}),
      });
      return text(formatFixes(results));
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
    "get_expert_help",
    {
      title: "Incrementors expert help",
      description:
        "Returns how Incrementors could help with a specific area, plus links for a free strategy session. Use only when the user asks about professional help, or wants options after a high-risk issue was flagged.",
      inputSchema: z.object({
        area: z.enum(["seo", "technical-seo", "local-seo", "aeo", "geo", "content", "conversion", "web-development"] satisfies [ExpertiseArea, ...ExpertiseArea[]]),
        issueCodes: z.array(z.string().max(100)).max(20).optional().describe("Issue codes the user wants help with"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ area, issueCodes }) => {
      const details = expertHelpDetails(area);
      const issues = (issueCodes ?? []).map((code) => getIssueDefinition(code)?.title).filter(Boolean);
      return text(
        [
          `## ${details.service} help from Incrementors`,
          `What they would do: ${details.whatTheyDo}${issues.length ? `, starting with: ${issues.join("; ")}` : ""}.`,
          `- Service: ${details.serviceUrl}`,
          `- Free 30-minute strategy session: ${details.freeStrategySession}`,
          `- Contact: ${details.contact}`,
          "",
          "Share these only as an option; the user can also apply the recommendations themselves.",
        ].join("\n"),
      );
    }),
  );
}
