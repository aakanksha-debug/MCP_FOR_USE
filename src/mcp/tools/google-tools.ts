import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { QUESTION_QUERY } from "@/core/search-data";
import { connectionStatus, createConnection, disconnect, getAccessToken } from "@/integrations/google/connections";
import { recentRange } from "@/integrations/google/dates";
import { listProperties, pageReport } from "@/integrations/google/ga4";
import { inspectUrl, listSites, searchAnalytics, type GscFilter } from "@/integrations/google/gsc";
import { resolveGscProperty } from "@/integrations/google/site-data";
import { guard, text } from "../respond";
import { connectionIdField, gscPropertyField, urlField } from "../schemas";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

function table(headers: string[], rows: (string | number)[][]): string {
  if (!rows.length) return "_No data for this period._";
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

export function registerGoogleTools(server: McpServer): void {
  server.registerTool(
    "google_connect",
    {
      title: "Connect Google Search Console and GA4",
      description:
        "Starts an optional, read-only Google sign-in so audits can be verified against Search Console and GA4 data. Returns a sign-in link for the user and a connectionId to pass to other tools after they finish. Only offer this when the user wants deeper, data-backed analysis.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(async () => {
      const connection = await createConnection();
      return text(
        [
          "## Connect Google (read-only)",
          `1. Ask the user to open this link and sign in with the Google account that has access to their Search Console and/or GA4: ${connection.signInUrl}`,
          `2. The link works once and expires in ${connection.expiresInMinutes} minutes.`,
          "3. When the user says they are done, call google_connection_status to confirm, then use the connectionId below.",
          "",
          `connectionId: \`${connection.connectionId}\``,
          "",
          "Access is read-only (Search Console and Analytics data). The user can disconnect any time with google_disconnect, or revoke access at https://myaccount.google.com/permissions.",
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "google_connection_status",
    {
      title: "Google connection status",
      description: "Checks whether the user finished Google sign-in for a connectionId, and which data (Search Console, GA4) is available.",
      inputSchema: z.object({ connectionId: connectionIdField }),
      annotations: READ_ONLY,
    },
    guard(async ({ connectionId }) => {
      const status = await connectionStatus(connectionId);
      if (status.status === "not_found") return text("No connection found for this ID (it may have expired). Run google_connect again.");
      if (status.status === "pending") return text("Sign-in has not been completed yet. Ask the user to finish signing in with the link.");
      return text(
        `Connected as ${status.email ?? "a Google account"} since ${status.connectedAt}. Search Console: ${status.searchConsole ? "yes" : "no"}. GA4: ${status.analytics ? "yes" : "no"}.`,
      );
    }),
  );

  server.registerTool(
    "google_disconnect",
    {
      title: "Disconnect Google",
      description: "Revokes Google access for a connectionId and deletes the stored tokens.",
      inputSchema: z.object({ connectionId: connectionIdField }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    guard(async ({ connectionId }) => {
      const removed = await disconnect(connectionId);
      return text(removed ? "Google access was revoked and the stored tokens were deleted." : "No active connection was found for this ID.");
    }),
  );

  server.registerTool(
    "gsc_list_properties",
    {
      title: "List Search Console properties",
      description: "Lists the Search Console properties the connected Google account can access.",
      inputSchema: z.object({ connectionId: connectionIdField }),
      annotations: READ_ONLY,
    },
    guard(async ({ connectionId }) => {
      const sites = await listSites(await getAccessToken(connectionId));
      return text(table(["Property", "Permission"], sites.map((site) => [site.siteUrl, site.permissionLevel])));
    }),
  );

  server.registerTool(
    "gsc_search_performance",
    {
      title: "Search Console performance",
      description:
        "Returns Search Console clicks, impressions, CTR and average position grouped by query, page, country, device or date. Filter by page or query text, or return only question searches (useful for AEO).",
      inputSchema: z.object({
        connectionId: connectionIdField,
        siteUrl: urlField.describe("Website URL or Search Console property"),
        gscProperty: gscPropertyField,
        days: z.number().int().min(7).max(480).optional().describe("Period length in days (default 28)"),
        dimensions: z.array(z.enum(["query", "page", "country", "device", "date"])).min(1).max(3).optional(),
        pageContains: z.string().max(500).optional(),
        queryContains: z.string().max(200).optional(),
        questionsOnly: z.boolean().optional(),
        rowLimit: z.number().int().min(1).max(250).optional().describe("Rows to return (default 50)"),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ connectionId, siteUrl, gscProperty, days, dimensions, pageContains, queryContains, questionsOnly, rowLimit }) => {
      const accessToken = await getAccessToken(connectionId);
      const property = await resolveGscProperty(accessToken, siteUrl, gscProperty);
      const range = recentRange(days ?? 28);
      const dims = dimensions ?? ["query"];
      const filters: GscFilter[] = [];
      if (pageContains) filters.push({ dimension: "page", operator: "contains", expression: pageContains });
      if (queryContains) filters.push({ dimension: "query", operator: "contains", expression: queryContains });
      if (questionsOnly) {
        filters.push({ dimension: "query", operator: "includingRegex", expression: "^(what|why|how|when|where|who|which|can|do|does|is|are|should)\\b" });
      }
      const limit = rowLimit ?? 50;
      let rows = await searchAnalytics(accessToken, property, { ...range, dimensions: dims, rowLimit: questionsOnly ? 1000 : limit, filters });
      if (questionsOnly) rows = rows.filter((row) => QUESTION_QUERY.test(row.keys[dims.indexOf("query")] ?? "")).slice(0, limit);
      return text(
        [
          `## Search Console: ${property}`,
          `${range.startDate} to ${range.endDate}`,
          "",
          table(
            [...dims, "Clicks", "Impressions", "CTR", "Position"],
            rows.map((row) => [...row.keys, row.clicks, row.impressions, `${(row.ctr * 100).toFixed(1)}%`, row.position.toFixed(1)]),
          ),
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "gsc_inspect_url",
    {
      title: "Search Console URL inspection",
      description:
        "Shows how Google sees a URL: indexed or not, coverage state, Google-selected vs declared canonical, robots.txt state, last crawl and rich result issues. Use to confirm indexation and canonical problems.",
      inputSchema: z.object({ connectionId: connectionIdField, url: urlField, gscProperty: gscPropertyField }),
      annotations: READ_ONLY,
    },
    guard(async ({ connectionId, url, gscProperty }) => {
      const accessToken = await getAccessToken(connectionId);
      const property = await resolveGscProperty(accessToken, url, gscProperty);
      const result = await inspectUrl(accessToken, property, url);
      const lines = Object.entries(result)
        .filter(([key]) => key !== "richResults")
        .map(([key, value]) => `- ${key}: ${value}`);
      const rich = result.richResults?.map((item) => `- ${item.type}: ${item.issues.length ? item.issues.join("; ") : "no issues"}`) ?? [];
      return text([`## URL inspection: ${url}`, `Property: ${property}`, "", ...lines, ...(rich.length ? ["", "**Rich results**", ...rich] : [])].join("\n"));
    }),
  );

  server.registerTool(
    "ga4_list_properties",
    {
      title: "List GA4 properties",
      description: "Lists the Google Analytics 4 properties the connected Google account can access.",
      inputSchema: z.object({ connectionId: connectionIdField }),
      annotations: READ_ONLY,
    },
    guard(async ({ connectionId }) => {
      const properties = await listProperties(await getAccessToken(connectionId));
      return text(table(["Property ID", "Name", "Account"], properties.map((p) => [p.propertyId, p.name, p.account])));
    }),
  );

  server.registerTool(
    "ga4_page_performance",
    {
      title: "GA4 page performance",
      description:
        "Returns sessions, engagement rate, average session duration, key events (conversions) and views per page from GA4. Use organicOnly to see organic search landing pages.",
      inputSchema: z.object({
        connectionId: connectionIdField,
        propertyId: z.string().regex(/^\d+$/).describe("Numeric GA4 property ID from ga4_list_properties"),
        days: z.number().int().min(7).max(365).optional().describe("Period length in days (default 28)"),
        pathContains: z.string().max(500).optional(),
        organicOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Rows to return (default 25)"),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ connectionId, propertyId, days, pathContains, organicOnly, limit }) => {
      const range = recentRange(days ?? 28, 1);
      const rows = await pageReport(await getAccessToken(connectionId), propertyId, {
        ...range,
        ...(pathContains ? { pathContains } : {}),
        organicOnly: organicOnly ?? false,
        limit: limit ?? 25,
      });
      return text(
        [
          `## GA4 property ${propertyId}${organicOnly ? " (organic search landing pages)" : ""}`,
          `${range.startDate} to ${range.endDate}`,
          "",
          table(
            ["Page", "Sessions", "Engagement", "Avg. duration", "Key events", "Views"],
            rows.map((row) => [
              row.path,
              row.sessions,
              `${(row.engagementRate * 100).toFixed(1)}%`,
              `${Math.round(row.averageSessionDuration)}s`,
              row.keyEvents,
              row.views,
            ]),
          ),
        ].join("\n"),
      );
    }),
  );
}
