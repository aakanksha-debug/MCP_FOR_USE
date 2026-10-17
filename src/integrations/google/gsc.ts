import type { SearchRow } from "@/core/search-data";
import { googleFetch } from "./errors";

const BASE = "https://searchconsole.googleapis.com";

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export async function listSites(accessToken: string): Promise<GscSite[]> {
  const data = await googleFetch<{ siteEntry?: GscSite[] }>(`${BASE}/webmasters/v3/sites`, accessToken);
  return (data.siteEntry ?? []).filter((site) => site.permissionLevel !== "siteUnverifiedUser");
}

/**
 * Picks the Search Console property covering a URL. Domain properties
 * (sc-domain:) are preferred because they include every protocol and subdomain.
 */
export function matchProperty(sites: GscSite[], url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const domain = sites
    .filter((site) => site.siteUrl.startsWith("sc-domain:"))
    .map((site) => site.siteUrl)
    .filter((siteUrl) => {
      const name = siteUrl.slice("sc-domain:".length).toLowerCase();
      return host === name || host.endsWith(`.${name}`);
    })
    .sort((a, b) => b.length - a.length)[0];
  if (domain) return domain;
  return sites
    .map((site) => site.siteUrl)
    .filter((siteUrl) => !siteUrl.startsWith("sc-domain:") && url.toLowerCase().startsWith(siteUrl.toLowerCase().replace(/\/?$/, "/").slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
}

export type GscDimension = "query" | "page" | "country" | "device" | "date";

export interface GscFilter {
  dimension: "query" | "page" | "country" | "device";
  operator: "contains" | "equals" | "notContains" | "notEquals" | "includingRegex" | "excludingRegex";
  expression: string;
}

export interface GscQuery {
  startDate: string;
  endDate: string;
  /** Empty for site totals. */
  dimensions: GscDimension[];
  rowLimit?: number;
  filters?: GscFilter[];
}

export interface GscRow {
  /** Absent on totals rows (no dimensions). */
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function searchAnalytics(accessToken: string, siteUrl: string, query: GscQuery): Promise<GscRow[]> {
  const data = await googleFetch<{ rows?: GscRow[] }>(
    `${BASE}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    accessToken,
    {
      body: {
        startDate: query.startDate,
        endDate: query.endDate,
        ...(query.dimensions.length ? { dimensions: query.dimensions } : {}),
        rowLimit: Math.min(query.rowLimit ?? 1000, 25_000),
        type: "web",
        dataState: "final",
        ...(query.filters?.length ? { dimensionFilterGroups: [{ groupType: "and", filters: query.filters }] } : {}),
      },
    },
  );
  return data.rows ?? [];
}

/** Query+page rows in the provider-neutral shape the audits use. */
export async function queryPageRows(accessToken: string, siteUrl: string, range: { startDate: string; endDate: string }, rowLimit = 5000): Promise<SearchRow[]> {
  const rows = await searchAnalytics(accessToken, siteUrl, { ...range, dimensions: ["query", "page"], rowLimit });
  return rows.map((row) => ({
    query: row.keys[0] ?? "",
    page: row.keys[1] ?? "",
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));
}

export interface UrlInspection {
  verdict?: string;
  coverageState?: string;
  indexingState?: string;
  robotsTxtState?: string;
  pageFetchState?: string;
  lastCrawlTime?: string;
  googleCanonical?: string;
  userCanonical?: string;
  richResults?: { type: string; issues: string[] }[];
}

export async function inspectUrl(accessToken: string, siteUrl: string, inspectionUrl: string): Promise<UrlInspection> {
  const data = await googleFetch<{
    inspectionResult?: {
      indexStatusResult?: UrlInspection;
      richResultsResult?: { detectedItems?: { richResultType: string; items?: { issues?: { issueMessage: string }[] }[] }[] };
    };
  }>(`${BASE}/v1/urlInspection/index:inspect`, accessToken, { body: { inspectionUrl, siteUrl, languageCode: "en-US" } });
  const status = data.inspectionResult?.indexStatusResult ?? {};
  const richResults = data.inspectionResult?.richResultsResult?.detectedItems?.map((item) => ({
    type: item.richResultType,
    issues: (item.items ?? []).flatMap((entry) => (entry.issues ?? []).map((issue) => issue.issueMessage)),
  }));
  return {
    ...(status.verdict ? { verdict: status.verdict } : {}),
    ...(status.coverageState ? { coverageState: status.coverageState } : {}),
    ...(status.indexingState ? { indexingState: status.indexingState } : {}),
    ...(status.robotsTxtState ? { robotsTxtState: status.robotsTxtState } : {}),
    ...(status.pageFetchState ? { pageFetchState: status.pageFetchState } : {}),
    ...(status.lastCrawlTime ? { lastCrawlTime: status.lastCrawlTime } : {}),
    ...(status.googleCanonical ? { googleCanonical: status.googleCanonical } : {}),
    ...(status.userCanonical ? { userCanonical: status.userCanonical } : {}),
    ...(richResults?.length ? { richResults } : {}),
  };
}

export interface SearchTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function searchTotals(accessToken: string, siteUrl: string, range: { startDate: string; endDate: string }): Promise<SearchTotals> {
  const [row] = await searchAnalytics(accessToken, siteUrl, { ...range, dimensions: [], rowLimit: 1 });
  return { clicks: row?.clicks ?? 0, impressions: row?.impressions ?? 0, ctr: row?.ctr ?? 0, position: row?.position ?? 0 };
}
