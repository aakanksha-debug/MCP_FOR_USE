import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { runFullAudit, type FullAuditResult } from "@/audits";
import { buildDeepAudit, expertAdviceItems, formatDeepAudit } from "@/analysis/deep-audit";
import { hasAnalytics, loadSearchAnalysis, loadTrafficAnalysis } from "@/analysis/load";
import { formatSearchAnalysis } from "@/analysis/search-performance";
import { formatTrafficAnalysis } from "@/analysis/traffic";
import { createAuditContext } from "@/core/context";
import type { Issue } from "@/core/types";
import { normalizeTargetUrl } from "@/core/url-guard";
import { expertAdviceBlock, nextAfterSearch, nextAfterTraffic } from "@/funnel/stages";
import { getIssueDefinition } from "@/policy/catalog";
import { classify } from "@/policy/classify";
import { guard, text } from "../respond";
import { requireGoogleConnection } from "../session";
import { connectionIdField, gscPropertyField, issueRefField, urlField } from "../schemas";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const daysField = z.number().int().min(7).max(90).optional().describe("Period length in days (default 28), compared with the period before");
const propertyIdField = z.string().regex(/^\d+$/).optional().describe("GA4 property ID; detected from the site's web stream when omitted");

export function registerAnalysisTools(server: McpServer): void {
  server.registerTool(
    "search_performance_analysis",
    {
      title: "Search Performance Analysis (Search Console)",
      description:
        "FUNNEL STAGE 4, after Search Console is connected. Shows how Google actually treats the site: clicks, impressions, CTR and average position versus the previous period, top queries and pages, and search visibility opportunities (pages seen but not clicked, queries almost on page one, real questions people search, queries without a dedicated page, competing pages). Ends with the next step (connect GA4).",
      inputSchema: z.object({ connectionId: connectionIdField, siteUrl: urlField, gscProperty: gscPropertyField, days: daysField }),
      annotations: READ_ONLY,
    },
    guard(async ({ connectionId: explicitId, siteUrl, gscProperty, days }, ctx) => {
      const connectionId = requireGoogleConnection(explicitId, ctx);
      const site = normalizeTargetUrl(siteUrl).toString();
      const analysis = await loadSearchAnalysis(connectionId, site, { ...(gscProperty ? { property: gscProperty } : {}), ...(days ? { days } : {}) });
      const expert = expertAdviceItems(buildDeepAudit({ site, issues: [], search: analysis }));
      return text(formatSearchAnalysis(analysis) + expertAdviceBlock(expert) + nextAfterSearch(await hasAnalytics(connectionId)));
    }),
  );

  server.registerTool(
    "traffic_analysis",
    {
      title: "Traffic & Conversion Analysis (GA4)",
      description:
        "FUNNEL STAGE 5, after Google Analytics is connected. Shows what happens after visitors arrive: sessions, users, engagement and conversions (key events) versus the previous period, traffic sources, top landing pages, pages where visitors leave quickly and pages with traffic but no conversions. Finds the GA4 property automatically. Ends with the next step (deep audit).",
      inputSchema: z.object({ connectionId: connectionIdField, siteUrl: urlField, propertyId: propertyIdField, days: daysField }),
      annotations: READ_ONLY,
    },
    guard(async ({ connectionId: explicitId, siteUrl, propertyId, days }, ctx) => {
      const connectionId = requireGoogleConnection(explicitId, ctx);
      const site = normalizeTargetUrl(siteUrl).toString();
      const analysis = await loadTrafficAnalysis(connectionId, site, { ...(propertyId ? { propertyId } : {}), ...(days ? { days } : {}) });
      const expert = expertAdviceItems(buildDeepAudit({ site, issues: [], traffic: analysis }));
      return text(formatTrafficAnalysis(analysis) + expertAdviceBlock(expert) + nextAfterTraffic());
    }),
  );

  server.registerTool(
    "data_driven_audit",
    {
      title: "Deep Data-Driven Audit (website + Search Console + GA4)",
      description:
        "FUNNEL STAGES 6-8. Combines the website audit with real Search Console and GA4 data and ranks problems by business impact (not by number of errors): pages seen but not clicked, ranking pages without traffic, traffic without engagement or conversions, underperforming service pages, searches without a strong landing page, content gaps from real demand, technical issues on important pages, AEO/GEO opportunities. Ends with the critical issues split into MCP-safe, needs-approval and expert work, and an Incrementors expert recommendation only when the findings support it. Pass the issues from the earlier audit to avoid re-crawling.",
      inputSchema: z.object({
        connectionId: connectionIdField,
        siteUrl: urlField,
        issues: z.array(issueRefField).max(80).optional().describe("Issues (code and url) from the earlier website audit"),
        gscProperty: gscPropertyField,
        propertyId: propertyIdField,
        days: daysField,
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ connectionId: explicitId, siteUrl, issues, gscProperty, propertyId, days }, ctx) => {
      const connectionId = requireGoogleConnection(explicitId, ctx);
      const site = normalizeTargetUrl(siteUrl).toString();
      const notes: string[] = [];
      const auditPromise: Promise<Issue[]> = issues?.length
        ? Promise.resolve(classify(issues.filter((issue) => getIssueDefinition(issue.code))))
        : runFullAudit(createAuditContext({ budgetMs: 30_000 }), { url: site, checks: ["seo", "technical", "schema", "aeo", "geo", "conversion", "content"] }).then(
            (full: FullAuditResult) => full.issues,
          );
      const searchPromise = loadSearchAnalysis(connectionId, site, { ...(gscProperty ? { property: gscProperty } : {}), ...(days ? { days } : {}) });
      const trafficPromise = hasAnalytics(connectionId).then((connected) =>
        connected
          ? loadTrafficAnalysis(connectionId, site, { ...(propertyId ? { propertyId } : {}), ...(days ? { days } : {}) }).catch((error: Error) => {
              notes.push(`Google Analytics data could not be used: ${error.message}`);
              return undefined;
            })
          : (notes.push("Google Analytics is not connected, so engagement and conversion data is not included."), undefined),
      );
      const [auditIssues, search, traffic] = await Promise.all([auditPromise, searchPromise, trafficPromise]);
      const deep = buildDeepAudit({ site, issues: auditIssues, search, ...(traffic ? { traffic } : {}) });
      return text(formatDeepAudit(deep) + (notes.length ? `\n\n_${notes.join(" ")}_` : ""));
    }),
  );
}
