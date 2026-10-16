/**
 * Provider-neutral search performance data and the analysis rules shared by
 * the content audit and the verification layer. Google Search Console is the
 * first provider; Bing Webmaster Tools could map onto the same shape later.
 */

export interface SearchRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Rough organic CTR by rounded position, used only to flag outliers. */
const EXPECTED_CTR = [0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.03, 0.025, 0.02];

export function expectedCtr(position: number): number {
  const index = Math.min(Math.max(Math.round(position), 1), 10) - 1;
  return EXPECTED_CTR[index] ?? 0.02;
}

export const QUESTION_QUERY = /^(what|why|how|when|where|who|which|can|could|do|does|is|are|should|will|would)\b|\?$/i;

export interface QueryInsight {
  query: string;
  page: string;
  impressions: number;
  clicks: number;
  position: number;
  ctr: number;
}

function insight(row: SearchRow): QueryInsight {
  return {
    query: row.query,
    page: row.page,
    impressions: row.impressions,
    clicks: row.clicks,
    position: Math.round(row.position * 10) / 10,
    ctr: Math.round(row.ctr * 1000) / 10,
  };
}

function byImpressions(a: SearchRow, b: SearchRow) {
  return b.impressions - a.impressions;
}

/** Scales minimum impressions to the site's size so small sites still get results. */
export function impressionFloor(rows: SearchRow[], base: number): number {
  const top = [...rows].sort(byImpressions)[Math.min(20, rows.length - 1)]?.impressions ?? 0;
  return Math.max(5, Math.min(base, Math.round(top / 2)));
}

export function strikingDistance(rows: SearchRow[], limit = 10): QueryInsight[] {
  const floor = impressionFloor(rows, 50);
  return rows
    .filter((row) => row.position >= 8 && row.position <= 20 && row.impressions >= floor)
    .sort(byImpressions)
    .slice(0, limit)
    .map(insight);
}

export function lowCtr(rows: SearchRow[], limit = 5): QueryInsight[] {
  const floor = impressionFloor(rows, 200);
  return rows
    .filter((row) => row.position <= 10 && row.impressions >= floor && row.ctr < expectedCtr(row.position) * 0.5)
    .sort(byImpressions)
    .slice(0, limit)
    .map(insight);
}

export function questionQueries(rows: SearchRow[], limit = 10): QueryInsight[] {
  return rows
    .filter((row) => QUESTION_QUERY.test(row.query.trim()) && row.position > 3)
    .sort(byImpressions)
    .slice(0, limit)
    .map(insight);
}

export interface Cannibalization {
  query: string;
  pages: { page: string; impressions: number; position: number }[];
}

export function cannibalization(rows: SearchRow[], limit = 5): Cannibalization[] {
  const byQuery = new Map<string, SearchRow[]>();
  for (const row of rows) byQuery.set(row.query, [...(byQuery.get(row.query) ?? []), row]);
  const results: (Cannibalization & { total: number })[] = [];
  for (const [query, list] of byQuery) {
    const total = list.reduce((sum, row) => sum + row.impressions, 0);
    const competing = list.filter((row) => row.impressions >= total * 0.1 && row.position <= 30);
    if (competing.length >= 2 && total >= 30) {
      results.push({
        query,
        total,
        pages: competing.map((row) => ({ page: row.page, impressions: row.impressions, position: Math.round(row.position * 10) / 10 })),
      });
    }
  }
  return results
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(({ query, pages }) => ({ query, pages }));
}

export function homepageOnly(rows: SearchRow[], homepage: string, limit = 10): QueryInsight[] {
  const home = homepage.replace(/\/+$/, "");
  const floor = impressionFloor(rows, 50);
  const pagesPerQuery = new Map<string, Set<string>>();
  for (const row of rows) pagesPerQuery.set(row.query, (pagesPerQuery.get(row.query) ?? new Set()).add(row.page.replace(/\/+$/, "")));
  return rows
    .filter(
      (row) =>
        row.page.replace(/\/+$/, "") === home &&
        pagesPerQuery.get(row.query)?.size === 1 &&
        row.query.split(/\s+/).length >= 3 &&
        row.impressions >= floor &&
        row.position > 5,
    )
    .sort(byImpressions)
    .slice(0, limit)
    .map(insight);
}
