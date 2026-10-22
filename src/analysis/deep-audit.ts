import type { Issue, Tier } from "@/core/types";
import { pathKey, verifyIssues, type VerificationData } from "@/decision/verify";
import { expertConversion, type TierCounts } from "@/funnel/stages";
import { getIssueDefinition } from "@/policy/catalog";
import { IMPACT_WEIGHT, TIERS } from "@/policy/tiers";
import type { SearchAnalysis } from "./search-performance";
import type { TrafficAnalysis } from "./traffic";

/**
 * Stage 6-8: combines the website audit with Search Console and GA4 so issues
 * are ranked by real business impact instead of by count. Pure function.
 */

export interface DeepItem {
  code: string;
  title: string;
  tier: Tier;
  source: "website" | "search" | "analytics";
  evidence: string;
  action: string;
  priority: number;
  pages: string[];
  /** Website issues only: real data confirms or suggests the problem matters. */
  verified?: boolean;
}

export interface DeepAudit {
  site: string;
  items: DeepItem[];
  counts: TierCounts;
  sources: string[];
}

const num = (value: number) => Math.round(value).toLocaleString("en-US");
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const path = (url: string) => {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
};

function priorityFor(code: string, volume: number, evidenceFactor: number): number {
  const definition = getIssueDefinition(code);
  const impact = definition ? IMPACT_WEIGHT[definition.impact] : 2;
  return Math.round(impact * (1 + Math.log10(1 + volume)) * evidenceFactor * 10) / 10;
}

function dataItem(code: string, source: DeepItem["source"], evidence: string, pages: string[], volume: number): DeepItem {
  const definition = getIssueDefinition(code)!;
  return {
    code,
    title: definition.title,
    tier: definition.tier,
    source,
    evidence,
    action: definition.recommendation,
    priority: priorityFor(code, volume, 2),
    pages,
  };
}

/** Why a strategic item needs careful planning, in plain words. */
export function whyPlanning(code: string, reason = ""): string {
  const text = `${code} ${reason}`.toLowerCase();
  if (/noindex|canonical|robots|index/.test(text)) return "A mistake here can remove pages from Google entirely.";
  if (/redirect|https|www|url|migration/.test(text)) return "Wrong redirects or URL changes can lose rankings and links built up over years.";
  if (/cannibal/.test(text)) return "Merging or re-targeting pages moves rankings between URLs; it needs a URL mapping plan.";
  if (/declin/.test(text)) return "A drop needs a diagnosis (algorithm update, technical change, competition) before anything is changed.";
  if (/schema|structured|snippet|json/.test(text)) return "Incorrect markup can remove rich results or trigger Google penalties.";
  if (/plugin|theme|code|server|hosting|performance|cwv|response|render/.test(text)) return "Plugin, theme, code or server changes can break layouts, forms or the whole site.";
  if (/gbp|profile/.test(text)) return "Business Profile changes done wrong can get the profile suspended.";
  if (/crawler|ai/.test(text)) return "This decides whether AI and search systems can read the whole site.";
  return "This affects rankings or site structure, so it should be planned and tested first.";
}

export function buildDeepAudit(input: { site: string; issues: Issue[]; search?: SearchAnalysis; traffic?: TrafficAnalysis }): DeepAudit {
  const { search, traffic } = input;
  const items: DeepItem[] = [];

  if (search) {
    const { change, input: data } = search;
    if (change.clicks !== null && change.clicks <= -20 && data.previous.clicks >= 100) {
      items.push(dataItem("data.search.declining", "search", `Clicks fell ${Math.abs(change.clicks)}% (${num(data.previous.clicks)} → ${num(data.current.clicks)}) versus the previous period.`, [], data.previous.clicks));
    }
    for (const page of search.lowCtrPages.slice(0, 3)) {
      items.push(
        dataItem(
          "data.page.low_ctr",
          "search",
          `${path(page.page)}: ${num(page.impressions)} impressions at position ${page.position.toFixed(1)} but ${pct(page.ctr)} CTR (about ${pct(page.expectedCtr)} is normal).`,
          [page.page],
          page.impressions / 10,
        ),
      );
    }
    for (const page of search.servicePages.slice(0, 2)) {
      items.push(dataItem("data.service_page.underperforming", "search", `${path(page.page)} averages position ${page.position.toFixed(1)} with ${num(page.impressions)} impressions.`, [page.page], page.impressions / 10));
    }
    if (search.strikingDistance.length) {
      const volume = search.strikingDistance.reduce((sum, q) => sum + q.impressions, 0);
      items.push(dataItem("content.gsc.striking_distance", "search", `${search.strikingDistance.length} queries rank 8-20, e.g. "${search.strikingDistance[0]!.query}" (${num(search.strikingDistance[0]!.impressions)} impressions).`, [...new Set(search.strikingDistance.map((q) => q.page))], volume / 10));
    }
    if (search.homepageOnly.length) {
      const volume = search.homepageOnly.reduce((sum, q) => sum + q.impressions, 0);
      items.push(dataItem("content.gsc.homepage_only", "search", `Searches like "${search.homepageOnly[0]!.query}" have no dedicated landing page (${search.homepageOnly.length} queries).`, [input.site], volume / 10));
    }
    if (search.questions.length) {
      const volume = search.questions.reduce((sum, q) => sum + q.impressions, 0);
      items.push(dataItem("content.gsc.question_queries", "search", `Real questions people search: ${search.questions.slice(0, 3).map((q) => `"${q.query}"`).join(", ")}.`, [...new Set(search.questions.map((q) => q.page))], volume / 10));
    }
    if (search.cannibalization.length) {
      const first = search.cannibalization[0]!;
      items.push(dataItem("content.gsc.cannibalization", "search", `"${first.query}" is split across ${first.pages.length} pages (${first.pages.map((p) => path(p.page)).join(", ")}).`, first.pages.map((p) => p.page), first.pages.reduce((sum, p) => sum + p.impressions, 0) / 10));
    }
  }

  if (traffic) {
    if (!traffic.keyEventsTracked) {
      items.push(dataItem("data.tracking.no_key_events", "analytics", `${num(traffic.input.current.sessions)} sessions but no key events recorded, so conversions can't be measured.`, [], traffic.input.current.sessions / 10));
    }
    for (const page of traffic.weakEngagement.slice(0, 2)) {
      items.push(dataItem("data.page.weak_engagement", "analytics", `${page.path}: ${num(page.sessions)} sessions, only ${pct(page.engagementRate)} engaged.`, [page.path], page.sessions));
    }
    for (const page of traffic.noConversions.slice(0, 2)) {
      items.push(dataItem("data.page.no_conversions", "analytics", `${page.path}: ${num(page.sessions)} sessions and no conversions.`, [page.path], page.sessions));
    }
  }

  // Website issues, re-ranked by what the data says about the affected pages.
  const verification: VerificationData = {
    search: new Map((search?.input.pages ?? []).map((page) => [pathKey(page.page), page])),
    analytics: new Map((traffic?.input.landingPages ?? []).map((page) => [pathKey(page.path), page])),
    inspections: new Map(),
    keyEventsTracked: traffic?.keyEventsTracked ?? false,
    hasSearchData: Boolean(search?.input.pages.length),
    hasAnalyticsData: Boolean(traffic?.input.landingPages.length),
  };
  const verified = verifyIssues(input.issues.map((issue) => ({ code: issue.code, url: issue.url })), verification);
  const byCode = new Map<string, DeepItem>();
  for (const entry of verified) {
    const issue = input.issues.find((candidate) => candidate.code === entry.code && candidate.url === entry.url);
    const existing = byCode.get(entry.code);
    const factor = entry.status === "confirmed" ? 1.6 : entry.status === "likely" ? 1.2 : entry.status === "not-visible-in-data" ? 0.4 : 0.8;
    const priority = Math.round(entry.priority * factor * 10) / 10;
    if (existing) {
      existing.pages.push(entry.url);
      if (priority > existing.priority) {
        existing.priority = priority;
        existing.evidence = `${entry.explanation}${issue?.detail ? ` (${issue.detail})` : ""}`;
      }
      existing.verified ||= entry.status === "confirmed" || entry.status === "likely";
      continue;
    }
    byCode.set(entry.code, {
      code: entry.code,
      title: entry.title,
      tier: entry.tier,
      source: "website",
      evidence: `${entry.explanation}${issue?.detail ? ` (${issue.detail})` : ""}`,
      action: issue?.recommendation ?? getIssueDefinition(entry.code)?.recommendation ?? "",
      priority,
      pages: [entry.url],
      verified: entry.status === "confirmed" || entry.status === "likely",
    });
  }
  items.push(...byCode.values());

  // One entry per code; data-derived entries win over website ones.
  const unique = new Map<string, DeepItem>();
  for (const item of items.sort((a, b) => b.priority - a.priority)) {
    const existing = unique.get(item.code);
    if (existing) existing.pages = [...new Set([...existing.pages, ...item.pages])];
    else unique.set(item.code, item);
  }
  const ranked = [...unique.values()].sort((a, b) => b.priority - a.priority);
  const counts: TierCounts = { safe: 0, medium: 0, high: 0 };
  for (const item of ranked) counts[item.tier] += 1;
  return {
    site: input.site,
    items: ranked,
    counts,
    sources: ["website audit", ...(search ? [`Search Console (${search.input.period})`] : []), ...(traffic ? [`Google Analytics (${traffic.input.period})`] : [])],
  };
}

function itemBlock(item: DeepItem, index: number): string {
  return [
    `${index}. ${TIERS[item.tier].emoji} **${item.title}**${item.pages.length > 1 ? ` · ${item.pages.length} pages` : item.pages[0] ? ` · ${path(item.pages[0])}` : ""}`,
    `   Evidence: ${item.evidence}`,
    `   ${item.tier === "high" ? "Why it needs an expert" : "Action"}: ${item.tier === "high" ? whyPlanning(item.code, getIssueDefinition(item.code)?.expertReason) : item.action}`,
  ].join("\n");
}

/**
 * Google data block for the first audit when the user signed in with Google:
 * the strongest search and traffic findings, then the website issues the data
 * says matter most. Notes explain any data that could not be loaded.
 */
export function formatDataHighlights(deep: DeepAudit | undefined, notes: string[], topCount = 5): string {
  const lines = ["", "", "### What your Google data shows"];
  if (deep) {
    lines.push(`Based on: ${deep.sources.filter((source) => source !== "website audit").join(" + ")}`, "");
    const dataItems = deep.items.filter((item) => item.source !== "website").slice(0, topCount);
    lines.push(...(dataItems.length ? dataItems.map((item, index) => itemBlock(item, index + 1)) : ["No major search or traffic problems stand out in this period."]));
    const backed = deep.items.filter((item) => item.source === "website" && item.verified).slice(0, 3);
    if (backed.length) {
      lines.push("", "**Website issues on the pages your data says matter most:**", ...backed.map((item) => `- ${TIERS[item.tier].emoji} ${item.title}: ${item.evidence}`));
    }
  }
  if (notes.length) lines.push("", `_${notes.join(" ")}_`);
  return lines.join("\n");
}

export function formatDeepAudit(deep: DeepAudit, topCount = 8): string {
  const host = (() => {
    try {
      return new URL(deep.site).hostname;
    } catch {
      return deep.site;
    }
  })();
  const top = deep.items.slice(0, topCount);
  const byTier = (tier: Tier) => deep.items.filter((item) => item.tier === tier);
  const lines: string[] = [
    `## Deep data-driven audit: ${host}`,
    `Based on: ${deep.sources.join(" + ")}`,
    "",
    `### What matters most (ranked by business impact)`,
    ...top.map((item, index) => itemBlock(item, index + 1)),
    "",
    "### Critical issues: who should handle what",
    `**🟢 MCP can safely handle (${byTier("safe").length})**${byTier("safe").length ? ": " + byTier("safe").map((item) => item.title).join("; ") : ""}`,
    `**🟡 Requires your approval (${byTier("medium").length})**${byTier("medium").length ? ": " + byTier("medium").slice(0, 6).map((item) => item.title).join("; ") + (byTier("medium").length > 6 ? "; and more" : "") : ""}`,
    `**🔴 Strategic / expert work (${byTier("high").length})**`,
    ...byTier("high").map((item) => `- **${item.title}**: ${whyPlanning(item.code, getIssueDefinition(item.code)?.expertReason)}`),
  ];
  return lines.join("\n") + expertConversion(deep.counts);
}
