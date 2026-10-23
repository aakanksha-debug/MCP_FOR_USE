import type { FullAuditResult } from "@/audits";
import { whyPlanning, type DeepAudit, type DeepItem } from "@/analysis/deep-audit";
import type { SearchAnalysis } from "@/analysis/search-performance";
import type { TrafficAnalysis } from "@/analysis/traffic";
import { BRAND } from "@/config/brand";
import type { AuditId, AuditResult, Tier } from "@/core/types";
import { nextAfterAudit, type GoogleState } from "@/funnel/stages";
import { TIERS } from "@/policy/tiers";
import { CATEGORY_LABEL, countGroups, groupIssues, rankGroups, type IssueGroup } from "./format";

/**
 * The first audit result, in the order the user sees it:
 *   1. SEO, AEO and GEO scores (plus the overall and other category scores)
 *   2. Google Search Console and Analytics: real numbers and data findings
 *   3. Website issues in three levels: 🟢 Minor (the MCP can fix), 🟡 Intermediate
 *      (recommend, client approves), 🔴 Advanced (expert review)
 *   4. The report card: things we can fix, things we recommend, one growth
 *      opportunity, and major issues requiring expert advice
 *   5. One next step
 */

export interface GoogleContext {
  state: GoogleState;
  deep?: DeepAudit;
  search?: SearchAnalysis;
  traffic?: TrafficAnalysis;
  notes?: string[];
}

const LEVEL: Record<Tier, { heading: string; note: string }> = {
  safe: { heading: "Minor issues", note: "safe, predefined fixes the MCP can make with your permission" },
  medium: { heading: "Intermediate issues", note: "recommended changes that need your approval" },
  high: { heading: "Advanced issues", note: "need expert review; the MCP never changes these" },
};

/** Codes that point at new traffic or leads, most valuable first, for the growth opportunity. */
const GROWTH_CODES = [
  "content.gsc.striking_distance",
  "data.page.low_ctr",
  "content.gsc.homepage_only",
  "data.service_page.underperforming",
  "content.gsc.question_queries",
  "data.page.no_conversions",
  "content.key_page.missing",
  "aeo.questions.uncovered",
  "aeo.questions.none",
  "content.pages.thin",
  "seo.content.thin",
  "geo.content.summary_unclear",
  "conversion.value_prop.unclear",
  "conversion.cta.missing",
];

const num = (value: number) => Math.round(value).toLocaleString("en-US");
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const trend = (change: number | null) => (change === null ? "" : ` (${change >= 0 ? "▲" : "▼"} ${Math.abs(change)}%)`);

function host(target: string): string {
  try {
    return new URL(target).hostname;
  } catch {
    return target;
  }
}

function where(group: IssueGroup): string {
  return group.urls.length === 1 ? group.urls[0]! : `${group.urls.length} pages, e.g. ${group.urls[0]}`;
}

function scoreSection(full: FullAuditResult): string[] {
  const score = (id: AuditId) => full.results.find((result) => result.audit === id)?.score;
  const headline = (["seo", "aeo", "geo"] as const).filter((id) => score(id) !== undefined);
  const others = (["technical", "conversion", "schema", "content", "gbp"] as const)
    .map((id) => full.results.find((result) => result.audit === id))
    .filter((result): result is AuditResult => Boolean(result))
    .map((result) => `${CATEGORY_LABEL[result.audit]} ${result.score}`);
  return [
    "### SEO, AEO and GEO scores",
    ...(headline.length
      ? [`| ${headline.map((id) => CATEGORY_LABEL[id]).join(" | ")} |`, `|${headline.map(() => "---").join("|")}|`, `| ${headline.map((id) => `**${score(id)}/100**`).join(" | ")} |`, ""]
      : []),
    `**Overall website score: ${full.overallScore}/100**${others.length ? ` · also checked: ${others.join(" · ")}` : ""}`,
  ];
}

function dataItemLine(item: DeepItem): string {
  return `- ${TIERS[item.tier].emoji} **${item.title}**: ${item.evidence}`;
}

function googleSection(google: GoogleContext): string[] {
  const heading = "### 📊 Google Search Console and Analytics";
  if (google.state === false) {
    return [
      heading,
      "Not connected. Connect Google (read-only, any Google account) to add real clicks, rankings, traffic and conversions, and to see which of these issues actually cost you visitors.",
    ];
  }
  const lines = [heading];
  if (google.search) {
    const { current, period } = google.search.input;
    lines.push(
      `**Search Console** (${period}): ${num(current.clicks)} clicks${trend(google.search.change.clicks)} · ${num(current.impressions)} impressions${trend(google.search.change.impressions)} · CTR ${pct(current.ctr)} · average position ${current.position.toFixed(1)}`,
    );
  }
  if (google.traffic) {
    const { current, period } = google.traffic.input;
    lines.push(
      `**Google Analytics** (${period}): ${num(current.sessions)} sessions${trend(google.traffic.change.sessions)} · ${pct(current.engagementRate)} engaged · ${google.traffic.keyEventsTracked ? `${num(current.keyEvents)} conversions${trend(google.traffic.change.keyEvents)}` : "conversions are not tracked"}`,
    );
  }
  const deep = google.deep;
  if (deep) {
    const dataItems = deep.items.filter((item) => item.source !== "website").slice(0, 3);
    lines.push("", dataItems.length ? "**What the data shows**" : "No major search or traffic problems stand out in this period.", ...dataItems.map(dataItemLine));
    const backed = deep.items.filter((item) => item.source === "website" && item.verified).slice(0, 3);
    if (backed.length) lines.push("", "**Website issues on the pages your data says matter most**", ...backed.map(dataItemLine));
  }
  if (google.notes?.length) lines.push("", `_${google.notes.join(" ")}_`);
  return lines;
}

function levelBlock(group: IssueGroup, index: number): string {
  const action =
    group.tier === "high"
      ? `Why it needs an expert: ${group.expertReason ?? whyPlanning(group.code)}`
      : `${group.tier === "safe" ? "Fix" : "Recommendation"}: ${group.recommendation}`;
  return [
    `${index}. **${group.title}** · ${CATEGORY_LABEL[group.category]} · ${where(group)}`,
    ...(group.details[0] ? [`   Evidence: ${group.details[0]}`] : []),
    `   ${action}`,
  ].join("\n");
}

function levelsSection(groups: IssueGroup[], perLevel: number): string[] {
  if (!groups.length) return ["### Issues", "We found no significant issues on the website."];
  const lines = [`### Issues on the website: ${groups.length} found`];
  for (const tier of ["safe", "medium", "high"] as const) {
    const inLevel = groups.filter((group) => group.tier === tier);
    lines.push("", `#### ${TIERS[tier].emoji} ${LEVEL[tier].heading} (${inLevel.length}): ${LEVEL[tier].note}`);
    if (!inLevel.length) {
      lines.push("None found.");
      continue;
    }
    lines.push(...inLevel.slice(0, perLevel).map((group, index) => levelBlock(group, index + 1)));
    if (inLevel.length > perLevel) lines.push(`…and ${inLevel.length - perLevel} more (ask to see all).`);
  }
  return lines;
}

interface Opportunity {
  code: string;
  title: string;
  detail: string;
}

function growthOpportunity(groups: IssueGroup[], deep?: DeepAudit): Opportunity | undefined {
  const fromData = deep?.items.filter((item) => item.source !== "website") ?? [];
  for (const code of GROWTH_CODES) {
    const item = fromData.find((candidate) => candidate.code === code);
    if (item) return { code, title: item.title, detail: `${item.evidence} ${item.action}`.trim() };
    const group = groups.find((candidate) => candidate.code === code);
    if (group) return { code, title: group.title, detail: `${group.details[0] ? `${group.details[0]}. ` : ""}${group.recommendation}` };
  }
  return undefined;
}

function reportCard(groups: IssueGroup[], google: GoogleContext): string[] {
  const growth = growthOpportunity(groups, google.deep);
  const safe = groups.filter((group) => group.tier === "safe");
  const recommend = groups.filter((group) => group.tier === "medium" && group.code !== growth?.code).slice(0, 2);
  const expert = groups.filter((group) => group.tier === "high");
  const pages = (group: IssueGroup) => (group.urls.length > 1 ? ` (${group.urls.length} pages)` : "");

  const lines = ["### 📋 Your report"];
  lines.push(
    safe.length
      ? `- ✅ **${safe.length} thing${safe.length === 1 ? "" : "s"} we can fix for you** (with your permission; nothing goes live until you approve it): ${safe.map((group) => `${group.title}${pages(group)}`).join("; ")}`
      : "- ✅ **Nothing needs a quick fix right now.**",
  );
  if (recommend.length) {
    lines.push(`- 🟡 **${recommend.length} thing${recommend.length === 1 ? "" : "s"} we recommend:**`, ...recommend.map((group) => `  - **${group.title}**: ${group.recommendation}`));
  }
  if (growth) lines.push(`- 🚀 **1 growth opportunity: ${growth.title}.** ${growth.detail}`);
  if (expert.length) {
    lines.push(
      `- 🔴 **${expert.length} major issue${expert.length === 1 ? "" : "s"} requiring expert advice:** ${expert
        .slice(0, 5)
        .map((group) => group.title)
        .join("; ")}${expert.length > 5 ? `; and ${expert.length - 5} more` : ""}`,
      `  These affect indexing, site structure, code or tracking, so they need careful planning; done wrong they can lose rankings or break the site. The MCP will not change them. An ${BRAND.strategistLabel} can review them with you: ${BRAND.strategySessionUrl}`,
    );
  } else {
    lines.push("- 🔴 **No major issues requiring expert advice.**");
  }
  return lines;
}

/** Stage 1 result: scores, Google data, issues in three levels, report card, one next step. */
export function formatAuditSummary(full: FullAuditResult, google: GoogleState | GoogleContext = false, perLevel = 5): string {
  const context: GoogleContext = typeof google === "object" ? google : { state: google };
  const groups = rankGroups(groupIssues(full.issues));
  const counts = countGroups(groups);
  const askUser = [...new Set(full.results.flatMap((result) => result.askUser))].slice(0, 3);
  const allRefs = full.issues.map((issue) => `- ${TIERS[issue.tier].emoji} \`${issue.code}\` ${issue.url}${issue.detail ? ` (${issue.detail})` : ""}`);

  return [
    `## Website audit: ${host(full.target)}`,
    "",
    ...scoreSection(full),
    "",
    ...googleSection(context),
    "",
    ...levelsSection(groups, perLevel),
    "",
    ...reportCard(groups, context),
    ...(full.skipped.length ? ["", ...full.skipped.map((item) => `_${item.reason}_`)] : []),
    ...(full.errors.length ? ["", `_Some checks could not run: ${full.errors.map((error) => `${CATEGORY_LABEL[error.audit]} (${error.message})`).join("; ")}_`] : []),
    ...(askUser.length ? ["", "**To make the next steps more accurate, it helps to know:**", ...askUser.map((item) => `- ${item}`)] : []),
    ...(allRefs.length
      ? ["", `<details><summary>All ${full.issues.length} findings (codes for follow-up tools; show only if the user asks)</summary>`, "", ...allRefs, "</details>"]
      : []),
  ].join("\n") + nextAfterAudit(counts, context.state);
}
