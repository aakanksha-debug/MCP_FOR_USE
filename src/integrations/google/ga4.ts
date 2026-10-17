import { googleFetch } from "./errors";

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";

export interface Ga4Property {
  propertyId: string;
  name: string;
  account: string;
}

export async function listProperties(accessToken: string): Promise<Ga4Property[]> {
  const data = await googleFetch<{
    accountSummaries?: { displayName: string; propertySummaries?: { property: string; displayName: string }[] }[];
  }>(`${ADMIN}/accountSummaries?pageSize=200`, accessToken);
  return (data.accountSummaries ?? []).flatMap((account) =>
    (account.propertySummaries ?? []).map((property) => ({
      propertyId: property.property.replace("properties/", ""),
      name: property.displayName,
      account: account.displayName,
    })),
  );
}

export interface Ga4PageRow {
  path: string;
  sessions: number;
  engagementRate: number;
  averageSessionDuration: number;
  keyEvents: number;
  views: number;
}

export interface Ga4PageReportOptions {
  startDate: string;
  endDate: string;
  /** Organic search landing pages only (uses the landingPage dimension). */
  organicOnly?: boolean;
  pathContains?: string;
  limit?: number;
}

const METRICS = ["sessions", "engagementRate", "averageSessionDuration", "keyEvents", "screenPageViews"];

export async function pageReport(accessToken: string, propertyId: string, options: Ga4PageReportOptions): Promise<Ga4PageRow[]> {
  const dimension = options.organicOnly ? "landingPage" : "pagePath";
  const filters: unknown[] = [];
  if (options.pathContains) {
    filters.push({ filter: { fieldName: dimension, stringFilter: { matchType: "CONTAINS", value: options.pathContains } } });
  }
  if (options.organicOnly) {
    filters.push({ filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } });
  }
  const data = await googleFetch<{
    rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  }>(`${DATA}/properties/${encodeURIComponent(propertyId)}:runReport`, accessToken, {
    body: {
      dateRanges: [{ startDate: options.startDate, endDate: options.endDate }],
      dimensions: [{ name: dimension }],
      metrics: METRICS.map((name) => ({ name })),
      ...(filters.length ? { dimensionFilter: filters.length === 1 ? filters[0] : { andGroup: { expressions: filters } } } : {}),
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: Math.min(options.limit ?? 500, 10_000),
    },
  });
  return (data.rows ?? []).map((row) => {
    const value = (index: number) => Number(row.metricValues[index]?.value ?? 0);
    return {
      path: row.dimensionValues[0]?.value ?? "",
      sessions: value(0),
      engagementRate: value(1),
      averageSessionDuration: value(2),
      keyEvents: value(3),
      views: value(4),
    };
  });
}

export interface Ga4Row {
  dims: string[];
  metrics: number[];
}

export interface Ga4ReportRequest {
  startDate: string;
  endDate: string;
  dimensions?: string[];
  metrics: string[];
  limit?: number;
  orderByMetric?: string;
}

/** Generic GA4 Data API report. */
export async function runReport(accessToken: string, propertyId: string, request: Ga4ReportRequest): Promise<Ga4Row[]> {
  const data = await googleFetch<{ rows?: { dimensionValues?: { value: string }[]; metricValues: { value: string }[] }[] }>(
    `${DATA}/properties/${encodeURIComponent(propertyId)}:runReport`,
    accessToken,
    {
      body: {
        dateRanges: [{ startDate: request.startDate, endDate: request.endDate }],
        ...(request.dimensions?.length ? { dimensions: request.dimensions.map((name) => ({ name })) } : {}),
        metrics: request.metrics.map((name) => ({ name })),
        ...(request.orderByMetric ? { orderBys: [{ metric: { metricName: request.orderByMetric }, desc: true }] } : {}),
        limit: Math.min(request.limit ?? 100, 10_000),
      },
    },
  );
  return (data.rows ?? []).map((row) => ({
    dims: (row.dimensionValues ?? []).map((value) => value.value),
    metrics: row.metricValues.map((value) => Number(value.value)),
  }));
}

/** Finds the GA4 property whose web data stream points at this site. */
export async function findPropertyForSite(accessToken: string, siteUrl: string): Promise<Ga4Property | undefined> {
  const host = new URL(siteUrl).hostname.replace(/^www\./, "");
  const properties = (await listProperties(accessToken)).slice(0, 25);
  for (const property of properties) {
    const data = await googleFetch<{ dataStreams?: { webStreamData?: { defaultUri?: string } }[] }>(
      `${ADMIN}/properties/${property.propertyId}/dataStreams?pageSize=50`,
      accessToken,
    ).catch(() => ({ dataStreams: [] }));
    const match = (data.dataStreams ?? []).some((stream) => {
      const uri = stream.webStreamData?.defaultUri;
      if (!uri) return false;
      try {
        return new URL(/^https?:/i.test(uri) ? uri : `https://${uri}`).hostname.replace(/^www\./, "") === host;
      } catch {
        return false;
      }
    });
    if (match) return property;
  }
  return undefined;
}
