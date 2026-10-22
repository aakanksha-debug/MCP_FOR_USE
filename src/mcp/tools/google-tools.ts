import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { QUESTION_QUERY } from "@/core/search-data";
import { connectionStatus, createConnection, disconnect, getAccessToken } from "@/integrations/google/connections";
import { recentRange } from "@/integrations/google/dates";
import { listProperties, pageReport } from "@/integrations/google/ga4";
import { inspectUrl, listSites, searchAnalytics, type GscFilter } from "@/integrations/google/gsc";
import { resolveGscProperty } from "@/integrations/google/site-data";
import { guard, text } from "../respond";
import { requireGoogleConnection, sessionGoogleConnection } from "../session";
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
      title: "Connect Google Search Console or Analytics",
      description:
        "Starts a read-only Google sign-in, one service at a time. Funnel order: first services ['search_console'] (after the website audit and safe fixes), later ['analytics'] with the same connectionId to add GA4 after the search analysis. Returns a sign-in link for the user and the connectionId to pass to the analysis tools.",
      inputSchema: z.object({
        services: z
          .array(z.enum(["search_console", "analytics"]))
          .min(1)
          .max(2)
          .optional()
          .describe("Which Google data to connect (default: search_console)"),
        connectionId: connectionIdField.optional().describe("Existing connectionId, to add a service to the same connection"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(async ({ services, connectionId }, ctx) => {
      const wanted = services ?? ["search_console"];
      const session = sessionGoogleConnection(ctx);
      let existing = connectionId;
      if (!existing && session) {
        const status = await connectionStatus(session);
        if (status.status === "connected") {
          const missing = wanted.filter((service) => !(service === "search_console" ? status.searchConsole : status.analytics));
          if (!missing.length) {
            return text(
              `Google is already connected for this session (signed in as ${status.email ?? "a Google account"} when the connector was added). Search Console: ${status.searchConsole ? "yes" : "no"}. Google Analytics: ${status.analytics ? "yes" : "no"}. No sign-in link or connectionId is needed: the audit and analysis tools use this data automatically.`,
            );
          }
          existing = session;
        }
      }
      const connection = await createConnection(wanted, existing);
      const label = wanted.map((service) => (service === "search_console" ? "Search Console" : "Google Analytics")).join(" and ");
      return text(
        [
          `## Connect ${label} (read-only)`,
          `1. Ask the user to open this link and sign in with the Google account that has access to their ${label}: ${connection.signInUrl}`,
          `2. The link works once and expires in ${connection.expiresInMinutes} minutes.`,
          "3. When the user says they are done, call google_connection_status to confirm.",
          "",
          existing && existing === session
            ? "This adds access to the Google account signed in for this connector. No connectionId is needed."
            : connection.adding
              ? "This adds access to the existing connection; keep using the same connectionId."
              : `connectionId: \`${connection.connectionId}\``,
          "",
          "Access is read-only. The user can disconnect any time with google_disconnect, or revoke access at https://myaccount.google.com/permissions.",
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
    guard(async ({ connectionId }, ctx) => {
      const status = await connectionStatus(requireGoogleConnection(connectionId, ctx));
      const using = connectionId ? "with this connectionId" : "(no connectionId needed; Google is connected for this session)";
      if (status.status === "not_found") return text("No connection found for this ID (it may have expired). Run google_connect again.");
      if (status.status === "pending") return text("Sign-in has not been completed yet. Ask the user to finish signing in with the link.");
      const next = status.searchConsole
        ? status.analytics
          ? `Next: data_driven_audit (or traffic_analysis) ${using}.`
          : `Next: search_performance_analysis ${using}. Offer Google Analytics after that.`
        : `Next: google_connect with services ["search_console"] ${using}.`;
      return text(
        `Connected as ${status.email ?? "a Google account"} since ${status.connectedAt}. Search Console: ${status.searchConsole ? "yes" : "no"}. Google Analytics: ${status.analytics ? "yes" : "no"}.\n${next}`,
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
    guard(async ({ connectionId }, ctx) => {
      const removed = await disconnect(requireGoogleConnection(connectionId, ctx));
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
    guard(async ({ connectionId }, ctx) => {
      const sites = await listSites(await getAccessToken(requireGoogleConnection(connectionId, ctx), "search_console"));
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
    guard(async ({ connectionId, siteUrl, gscProperty, days, dimensions, pageContains, queryContains, questionsOnly, rowLimit }, ctx) => {
      const accessToken = await getAccessToken(requireGoogleConnection(connectionId, ctx), "search_console");
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
    guard(async ({ connectionId, url, gscProperty }, ctx) => {
      const accessToken = await getAccessToken(requireGoogleConnection(connectionId, ctx), "search_console");
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
    guard(async ({ connectionId }, ctx) => {
      const properties = await listProperties(await getAccessToken(requireGoogleConnection(connectionId, ctx), "analytics"));
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
    guard(async ({ connectionId, propertyId, days, pathContains, organicOnly, limit }, ctx) => {
      const range = recentRange(days ?? 28, 1);
      const rows = await pageReport(await getAccessToken(requireGoogleConnection(connectionId, ctx), "analytics"), propertyId, {
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
