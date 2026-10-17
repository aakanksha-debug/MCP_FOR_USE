import { connectionStatus, getAccessToken } from "@/integrations/google/connections";
import { recentRange } from "@/integrations/google/dates";
import { GoogleIntegrationError } from "@/integrations/google/errors";
import { findPropertyForSite, listProperties, runReport } from "@/integrations/google/ga4";
import { queryPageRows, searchAnalytics, searchTotals } from "@/integrations/google/gsc";
import { resolveGscProperty } from "@/integrations/google/site-data";
import { analyzeSearch, type SearchAnalysis } from "./search-performance";
import { analyzeTraffic, type TrafficAnalysis } from "./traffic";

/** Fetches Google data for the analyses. Kept apart from the pure analysis code. */

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

export async function loadSearchAnalysis(connectionId: string, site: string, options: { property?: string; days?: number } = {}): Promise<SearchAnalysis> {
  const accessToken = await getAccessToken(connectionId, "search_console");
  const property = await resolveGscProperty(accessToken, site, options.property);
  const days = options.days ?? 28;
  const current = recentRange(days);
  const previous = recentRange(days, 3, days);
  const [now, before, pages, queries, rows] = await Promise.all([
    searchTotals(accessToken, property, current),
    searchTotals(accessToken, property, previous),
    searchAnalytics(accessToken, property, { ...current, dimensions: ["page"], rowLimit: 500 }),
    searchAnalytics(accessToken, property, { ...current, dimensions: ["query"], rowLimit: 50 }),
    queryPageRows(accessToken, property, current, 5000),
  ]);
  return analyzeSearch({
    site,
    property,
    period: `Last ${days} days (${current.startDate} to ${current.endDate})`,
    current: now,
    previous: before,
    pages: pages
      .filter((row) => sameHost(row.keys[0] ?? "", site))
      .map((row) => ({ page: row.keys[0] ?? "", clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position })),
    queries: queries.map((row) => ({ query: row.keys[0] ?? "", clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position })),
    rows: rows.filter((row) => sameHost(row.page, site)),
  });
}

export async function hasAnalytics(connectionId: string): Promise<boolean> {
  const status = await connectionStatus(connectionId);
  return status.status === "connected" && Boolean(status.analytics);
}

export async function hasSearchConsole(connectionId: string): Promise<boolean> {
  const status = await connectionStatus(connectionId);
  return status.status === "connected" && Boolean(status.searchConsole);
}

const TOTAL_METRICS = ["sessions", "totalUsers", "engagementRate", "keyEvents"];
const PAGE_METRICS = ["sessions", "engagementRate", "keyEvents"];

export async function loadTrafficAnalysis(connectionId: string, site: string, options: { propertyId?: string; days?: number } = {}): Promise<TrafficAnalysis> {
  const accessToken = await getAccessToken(connectionId, "analytics");
  let propertyId = options.propertyId;
  let propertyName = propertyId ? `Property ${propertyId}` : "";
  if (!propertyId) {
    const match = await findPropertyForSite(accessToken, site);
    if (!match) {
      const available = (await listProperties(accessToken)).slice(0, 8).map((p) => `${p.name} (${p.propertyId})`);
      throw new GoogleIntegrationError(
        `No GA4 property with a web stream for ${new URL(site).hostname} was found.${available.length ? ` Available: ${available.join(", ")}. Pass the right propertyId.` : " This Google account has no GA4 properties."}`,
        "not_found",
      );
    }
    propertyId = match.propertyId;
    propertyName = match.name;
  }
  const days = options.days ?? 28;
  const current = recentRange(days, 1);
  const previous = recentRange(days, 1, days);
  const [now, before, channels, landing] = await Promise.all([
    runReport(accessToken, propertyId, { ...current, metrics: TOTAL_METRICS }),
    runReport(accessToken, propertyId, { ...previous, metrics: TOTAL_METRICS }),
    runReport(accessToken, propertyId, { ...current, dimensions: ["sessionDefaultChannelGroup"], metrics: PAGE_METRICS, orderByMetric: "sessions", limit: 10 }),
    runReport(accessToken, propertyId, { ...current, dimensions: ["landingPage"], metrics: PAGE_METRICS, orderByMetric: "sessions", limit: 200 }),
  ]);
  const totals = (rows: typeof now) => ({
    sessions: rows[0]?.metrics[0] ?? 0,
    users: rows[0]?.metrics[1] ?? 0,
    engagementRate: rows[0]?.metrics[2] ?? 0,
    keyEvents: rows[0]?.metrics[3] ?? 0,
  });
  return analyzeTraffic({
    propertyName,
    propertyId,
    period: `Last ${days} days (${current.startDate} to ${current.endDate})`,
    current: totals(now),
    previous: totals(before),
    channels: channels.map((row) => ({ channel: row.dims[0] ?? "", sessions: row.metrics[0] ?? 0, engagementRate: row.metrics[1] ?? 0, keyEvents: row.metrics[2] ?? 0 })),
    landingPages: landing.map((row) => ({ path: row.dims[0] ?? "", sessions: row.metrics[0] ?? 0, engagementRate: row.metrics[1] ?? 0, keyEvents: row.metrics[2] ?? 0 })),
  });
}
