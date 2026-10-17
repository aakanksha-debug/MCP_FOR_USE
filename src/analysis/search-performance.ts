import {
  cannibalization,
  expectedCtr,
  homepageOnly,
  impressionFloor,
  lowCtr,
  questionQueries,
  strikingDistance,
  type Cannibalization,
  type QueryInsight,
  type SearchRow,
} from "@/core/search-data";
import type { SearchTotals } from "@/integrations/google/gsc";

/** Search Console analysis: how Google actually treats the site. Pure; the tool layer fetches the data. */

export interface PageRow {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalysisInput {
  site: string;
  property: string;
  period: string;
  current: SearchTotals;
  previous: SearchTotals;
  pages: PageRow[];
  queries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
  rows: SearchRow[];
}

export interface PageInsight extends PageRow {
  expectedCtr: number;
}

export interface SearchAnalysis {
  input: SearchAnalysisInput;
  change: { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null };
  lowCtrPages: PageInsight[];
  servicePages: PageRow[];
  strikingDistance: QueryInsight[];
  lowCtrQueries: QueryInsight[];
  questions: QueryInsight[];
  cannibalization: Cannibalization[];
  homepageOnly: QueryInsight[];
}

const SERVICE_PATH = /\/(services?|solutions|what-we-do|treatments|practice-areas|locations?|areas?-we-serve|service-areas?|products?|pricing)(\/|$)/i;

function percentChange(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

export function analyzeSearch(input: SearchAnalysisInput): SearchAnalysis {
  const floor = impressionFloor(input.rows.length ? input.rows : input.pages.map((page) => ({ ...page, query: "" })), 100);
  const lowCtrPages = input.pages
    .filter((page) => page.position <= 15 && page.impressions >= floor && page.ctr < expectedCtr(page.position) * 0.5)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 5)
    .map((page) => ({ ...page, expectedCtr: expectedCtr(page.position) }));
  const servicePages = input.pages
    .filter((page) => {
      try {
        return SERVICE_PATH.test(new URL(page.page).pathname) && page.position > 10 && page.impressions >= Math.max(10, floor / 4);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 5);
  return {
    input,
    change: {
      clicks: percentChange(input.current.clicks, input.previous.clicks),
      impressions: percentChange(input.current.impressions, input.previous.impressions),
      ctr: input.previous.ctr ? Math.round((input.current.ctr - input.previous.ctr) * 1000) / 10 : null,
      position: input.previous.position ? Math.round((input.current.position - input.previous.position) * 10) / 10 : null,
    },
    lowCtrPages,
    servicePages,
    strikingDistance: strikingDistance(input.rows, 5),
    lowCtrQueries: lowCtr(input.rows, 5),
    questions: questionQueries(input.rows, 5),
    cannibalization: cannibalization(input.rows, 3),
    homepageOnly: homepageOnly(input.rows, input.site, 5),
  };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const num = (value: number) => Math.round(value).toLocaleString("en-US");
const trend = (value: number | null, unit = "%", invert = false) => {
  if (value === null) return "";
  const good = invert ? value < 0 : value > 0;
  const arrow = value === 0 ? "→" : good ? "▲" : "▼";
  return ` (${arrow} ${value > 0 ? "+" : ""}${value}${unit} vs previous period)`;
};
const path = (url: string) => {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
};

export function formatSearchAnalysis(analysis: SearchAnalysis): string {
  const { input, change } = analysis;
  const lines: string[] = [
    `## Search performance: ${input.property}`,
    `${input.period}`,
    "",
    `- **Clicks:** ${num(input.current.clicks)}${trend(change.clicks)}`,
    `- **Impressions:** ${num(input.current.impressions)}${trend(change.impressions)}`,
    `- **CTR:** ${pct(input.current.ctr)}${trend(change.ctr, " pts")}`,
    `- **Average position:** ${input.current.position.toFixed(1)}${trend(change.position, "", true)}`,
  ];
  if (input.queries.length) {
    lines.push("", "**Top queries**", ...input.queries.slice(0, 5).map((q) => `- "${q.query}": ${num(q.clicks)} clicks, ${num(q.impressions)} impressions, position ${q.position.toFixed(1)}`));
  }
  if (input.pages.length) {
    lines.push("", "**Top pages**", ...input.pages.slice(0, 5).map((p) => `- ${path(p.page)}: ${num(p.clicks)} clicks, ${num(p.impressions)} impressions, CTR ${pct(p.ctr)}`));
  }

  const opportunities: string[] = [];
  for (const page of analysis.lowCtrPages.slice(0, 3)) {
    opportunities.push(`**Seen but not clicked:** ${path(page.page)} has ${num(page.impressions)} impressions at position ${page.position.toFixed(1)} but ${pct(page.ctr)} CTR (about ${pct(page.expectedCtr)} is normal). A better title and description could win more clicks.`);
  }
  if (analysis.strikingDistance.length) {
    const q = analysis.strikingDistance[0]!;
    opportunities.push(`**Almost on page one:** ${analysis.strikingDistance.length} queries rank 8-20, e.g. "${q.query}" (position ${q.position}, ${num(q.impressions)} impressions). Small improvements can move these up.`);
  }
  if (analysis.questions.length) {
    opportunities.push(`**Questions people search:** ${analysis.questions.slice(0, 3).map((q) => `"${q.query}"`).join(", ")}. Answering these directly helps Google and AI answers.`);
  }
  if (analysis.homepageOnly.length) {
    opportunities.push(`**No dedicated page:** ${analysis.homepageOnly.length} specific searches only land on the homepage, e.g. "${analysis.homepageOnly[0]!.query}".`);
  }
  if (analysis.cannibalization.length) {
    opportunities.push(`**Pages competing with each other:** "${analysis.cannibalization[0]!.query}" is split across ${analysis.cannibalization[0]!.pages.length} pages.`);
  }
  if (analysis.servicePages.length) {
    opportunities.push(`**Service pages beyond page one:** ${analysis.servicePages.slice(0, 2).map((p) => `${path(p.page)} (position ${p.position.toFixed(1)})`).join(", ")}.`);
  }
  if (change.clicks !== null && change.clicks <= -20 && input.previous.clicks >= 100) {
    opportunities.unshift(`**Clicks dropped ${Math.abs(change.clicks)}%** compared with the previous period. That needs a diagnosis before changing pages.`);
  }
  lines.push("", "### What this means", ...(opportunities.length ? opportunities.map((item) => `- ${item}`) : ["- No clear search opportunities stood out in this period."]));
  return lines.join("\n");
}
