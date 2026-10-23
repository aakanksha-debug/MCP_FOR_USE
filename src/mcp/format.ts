import type { FullAuditResult } from "@/audits";
import type { AuditId, AuditResult, Impact, Issue, Tier } from "@/core/types";
import { expertAdviceBlock, expertConversion, type ExpertAdviceItem } from "@/funnel/stages";
import { getIssueDefinition } from "@/policy/catalog";
import type { ExpertRecommendation } from "@/decision/recommend";
import type { VerifiedIssue } from "@/decision/verify";
import type { StageSummary } from "@/approvals/stage";
import { publicBaseUrl } from "@/config/env";
import type { FixResult } from "@/fixes/plan";
import { countByTier } from "@/policy/classify";
import { IMPACT_WEIGHT, TIERS, TIER_ORDER } from "@/policy/tiers";

/**
 * Markdown renderers for tool results. Every issue line carries its code and
 * URL so Claude can pass them back to verify_issues_with_data and prepare_fixes.
 */

const NEXT_STEP: Record<Tier, string> = {
  safe: "can be fixed with the user's permission (`prepare_fixes`); nothing is published until the site owner approves",
  medium: "recommend first; prepare a draft only after the user approves",
  high: "the MCP will not change these. ⚠️ Contact an Incrementors SEO strategist before touching them",
};

function issueLine(issue: Issue, index: number, withWhy: boolean): string {
  const lines = [`${index}. **${issue.title}** \`${issue.code}\` ${issue.url}`];
  if (issue.detail) lines.push(`   ${issue.detail}`);
  if (issue.tier === "high") lines.push(`   ⚠️ Expert needed: ${issue.expertReason ?? "high-risk change"}`);
  if (withWhy) lines.push(`   Why: ${issue.why}`);
  lines.push(`   ${issue.tier === "high" ? "What an expert would do" : "Fix"}: ${issue.recommendation}`);
  return lines.join("\n");
}

export function formatIssues(issues: Issue[], options: { withWhy?: boolean; limitPerTier?: number } = {}): string {
  if (!issues.length) return "No issues found.";
  const sections: string[] = [];
  for (const tier of TIER_ORDER) {
    const inTier = issues.filter((issue) => issue.tier === tier);
    if (!inTier.length) continue;
    const definition = TIERS[tier];
    const limit = options.limitPerTier ?? inTier.length;
    const shown = inTier.slice(0, limit).map((issue, index) => issueLine(issue, index + 1, options.withWhy ?? true));
    const more = inTier.length > limit ? `\n…and ${inTier.length - limit} more ${definition.label.toLowerCase()} issues.` : "";
    sections.push(`### ${definition.emoji} ${definition.label} (${inTier.length}): ${NEXT_STEP[tier]}\n${shown.join("\n")}${more}`);
  }
  return sections.join("\n\n");
}

function list(title: string, items: string[]): string {
  return items.length ? `\n\n**${title}**\n${items.map((item) => `- ${item}`).join("\n")}` : "";
}

/** Offered after single-check results while Google is not connected. */
export const GOOGLE_OFFER =
  "**🔗 Want data-backed results? Continue → Connect Google Search Console** (optional, read-only, about a minute). I can then check which of these issues actually cost you visibility, clicks and traffic, and prioritize the fixes by impact. Say \"connect Search Console\" to start.";

function googleOfferBlock(offer: boolean): string {
  return offer ? `\n\n${GOOGLE_OFFER}` : "";
}

/** The 🔴 issues in a result, for the expert advice block every result ends with. */
function expertItems(issues: Pick<Issue, "tier" | "title" | "expertReason">[]): ExpertAdviceItem[] {
  return issues.filter((issue) => issue.tier === "high").map((issue) => ({ title: issue.title, ...(issue.expertReason ? { reason: issue.expertReason } : {}) }));
}

export function formatAuditResult(result: AuditResult, recommendation: ExpertRecommendation | null, googleOffer = false): string {
  const counts = countByTier(result.issues);
  const header = [
    `## ${result.name}: ${result.target}`,
    `Score: **${result.score}/100** · 🔴 ${counts.high} · 🟡 ${counts.medium} · 🟢 ${counts.safe}`,
  ].join("\n");
  const facts = Object.keys(result.facts).length ? `\n\n<details><summary>Data collected</summary>\n\n\`\`\`json\n${JSON.stringify(result.facts, null, 1).slice(0, 4000)}\n\`\`\`\n</details>` : "";
  return [
    header,
    "\n\n",
    formatIssues(result.issues),
    list("Already good", result.passed),
    list("Ask the user", result.askUser),
    list("Notes", result.notes),
    facts,
    expertAdviceBlock(expertItems(result.issues), recommendation?.area),
    googleOfferBlock(googleOffer),
  ].join("");
}

export function formatFullAudit(full: FullAuditResult, recommendation: ExpertRecommendation | null, googleOffer = false): string {
  const counts = countByTier(full.issues);
  const scoreboard = full.results.map((result) => `| ${result.name} | ${result.score}/100 | ${result.issues.length} |`).join("\n");
  const askUser = [...new Set(full.results.flatMap((result) => result.askUser))];
  const notes = [...new Set(full.results.flatMap((result) => result.notes))];
  return [
    `## Full website audit: ${full.target}`,
    `Overall score: **${full.overallScore}/100** · 🔴 ${counts.high} · 🟡 ${counts.medium} · 🟢 ${counts.safe}`,
    "",
    "| Check | Score | Issues |",
    "|---|---|---|",
    scoreboard,
    "",
    formatIssues(full.issues, { withWhy: false, limitPerTier: 15 }),
    full.errors.length ? list("Checks that could not run", full.errors.map((error) => `${error.audit}: ${error.message}`)) : "",
    full.skipped.length ? list("Left out", full.skipped.map((item) => item.reason)) : "",
    list("Ask the user", askUser),
    list("Notes", notes),
    expertAdviceBlock(expertItems(full.issues), recommendation?.area),
    googleOfferBlock(googleOffer),
  ].join("\n");
}

const STATUS_LABEL: Record<VerifiedIssue["status"], string> = {
  confirmed: "✅ Confirmed by data",
  likely: "🔎 Likely affecting results",
  "insufficient-data": "❔ Not enough data",
  "not-visible-in-data": "➖ No visible impact",
};

export function formatVerification(
  verified: VerifiedIssue[],
  context: { property?: string; ga4PropertyId?: string; period: string; notes: string[] },
  recommendation: ExpertRecommendation | null,
): string {
  const lines = verified.map(
    (item, index) =>
      `${index + 1}. ${TIERS[item.tier].emoji} **${item.title}** \`${item.code}\` ${item.url}\n   ${STATUS_LABEL[item.status]}: ${item.explanation} (priority ${item.priority})`,
  );
  const counts = verified.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }), {});
  return [
    "## Issues checked against real data",
    `Search Console: ${context.property ?? "not used"} · GA4: ${context.ga4PropertyId ?? "not used"} · Period: ${context.period}`,
    `Confirmed ${counts.confirmed ?? 0} · Likely ${counts.likely ?? 0} · No visible impact ${counts["not-visible-in-data"] ?? 0} · Not enough data ${counts["insufficient-data"] ?? 0}`,
    "",
    "Sorted by priority (impact × traffic × evidence):",
    lines.join("\n"),
    list("Notes", context.notes),
    expertAdviceBlock(
      expertItems(verified.map((item) => ({ tier: item.tier, title: item.title, expertReason: getIssueDefinition(item.code)?.expertReason }))),
      recommendation?.area,
    ),
  ].join("\n");
}

/** Fix requests the policy refused because they need an expert. */
function expertFixItems(results: FixResult[]): ExpertAdviceItem[] {
  return results
    .filter((result) => result.outcome.status === "expert-review")
    .map((result) => ({ title: result.title, ...(getIssueDefinition(result.code)?.expertReason ? { reason: getIssueDefinition(result.code)!.expertReason! } : {}) }));
}

export function formatFixes(results: FixResult[], options: { expertBlock?: boolean } = {}): string {
  const blocks = results.map((result) => {
    const emoji = result.tier === "unknown" ? "❔" : TIERS[result.tier].emoji;
    const head = `### ${emoji} ${result.title} \`${result.code}\`\n${result.url}`;
    const outcome = result.outcome;
    switch (outcome.status) {
      case "ready":
        return `${head}\n**Prepared (not published).**\n${outcome.changes
          .map(
            (change) =>
              `- ${change.description}${change.before ? `\n  Before: ${change.before}` : ""}\n  After: ${change.after}\n  Manual option: ${change.whereToApply}${change.notes?.length ? `\n  Note: ${change.notes.join(" ")}` : ""}`,
          )
          .join("\n")}`;
      case "needs-approval":
        return `${head}\n**Needs the user's approval first.** Proposal: ${outcome.proposal}`;
      case "draft":
        return `${head}\n**Draft (approved by the user, review before publishing):** ${outcome.draft.summary}${outcome.draft.draft ? `\n\`\`\`\n${outcome.draft.draft}\n\`\`\`` : ""}${outcome.draft.guidance.length ? `\n${outcome.draft.guidance.map((line) => `- ${line}`).join("\n")}` : ""}`;
      case "expert-review":
        return `${head}\n**${outcome.reason}**\nWhat an expert would do: ${outcome.whatIsNeeded}`;
      case "not-detected":
        return `${head}\n${outcome.reason}`;
      case "error":
        return `${head}\nCould not prepare a fix: ${outcome.reason}`;
    }
  });
  return [
    "## Prepared fixes",
    "Nothing has been changed on the website.",
    "",
    blocks.join("\n\n"),
  ].join("\n") + (options.expertBlock === false ? "" : expertAdviceBlock(expertFixItems(results)));
}

/** Result of staging fixes for owner approval on a connected website. */
export function formatStaged(results: FixResult[], staged: StageSummary): string {
  const lines: string[] = ["## Fixes staged for approval"];
  if (staged.approval) {
    const url = `${publicBaseUrl()}/approve/${staged.approval.id}`;
    lines.push(
      `**Nothing has been published.** ${staged.approval.changes.length} change${staged.approval.changes.length === 1 ? " is" : "s are"} waiting for the site owner's approval.`,
      "",
      `Approval page (share with the site owner): ${url}`,
      "",
      "On that page the owner sees every before/after, can untick changes, and clicks **Approve & publish**. Published changes can be undone there for 30 days. The link expires in 7 days.",
      "",
      "**Waiting for approval**",
      ...staged.approval.changes.map((change) => `- ${change.label}: "${change.before}" → "${change.after}"`),
      "",
      `approvalId: \`${staged.approval.id}\` (use fix_approval_status to check what was published)`,
    );
  } else {
    lines.push("No change could be published automatically on this website, so no approval page was created.");
  }
  if (staged.manual.length) {
    lines.push("", "**Manual steps (cannot be published automatically)**", ...staged.manual.map((item) => `- ${item.issueTitle} on ${item.pageUrl}: use "${item.text}". ${item.reason}`));
  }
  const other = results.filter((result) => ["needs-approval", "draft", "not-detected", "error"].includes(result.outcome.status));
  if (other.length) lines.push("", formatFixes(other, { expertBlock: false }));
  return (
    lines.join("\n") +
    expertAdviceBlock([
      ...staged.expert.map((item) => ({ title: `${item.issueTitle} (${item.pageUrl})`, reason: item.reason })),
      ...expertFixItems(results),
    ])
  );
}

// ---------------------------------------------------------------- Stage 1 summary

export const CATEGORY_LABEL: Record<AuditId, string> = {
  seo: "SEO",
  aeo: "AEO",
  geo: "GEO",
  technical: "Technical",
  conversion: "Conversion",
  schema: "Schema",
  content: "Content",
  gbp: "Local (GBP)",
};

const CATEGORY_ORDER: AuditId[] = ["seo", "aeo", "geo", "technical", "conversion", "schema", "content", "gbp"];

/** All findings with the same issue code, counted once as one opportunity. */
export interface IssueGroup {
  code: string;
  title: string;
  tier: Tier;
  impact: Impact;
  category: AuditId;
  why: string;
  recommendation: string;
  expertReason?: string;
  urls: string[];
  details: string[];
}

export function groupIssues(issues: Issue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    const group = groups.get(issue.code) ?? {
      code: issue.code,
      title: issue.title,
      tier: issue.tier,
      impact: issue.impact,
      category: issue.category,
      why: issue.why,
      recommendation: issue.recommendation,
      ...(issue.expertReason ? { expertReason: issue.expertReason } : {}),
      urls: [],
      details: [],
    };
    if (!group.urls.includes(issue.url)) group.urls.push(issue.url);
    if (issue.detail && group.details.length < 3) group.details.push(issue.detail);
    groups.set(issue.code, group);
  }
  return [...groups.values()];
}

const TIER_BONUS: Record<Tier, number> = { high: 3, medium: 2, safe: 1 };

/** Most important first: expected impact, then risk, then how widespread. */
export function rankGroups(groups: IssueGroup[]): IssueGroup[] {
  const score = (group: IssueGroup) => IMPACT_WEIGHT[group.impact] * 10 + TIER_BONUS[group.tier] + Math.min(group.urls.length, 5) * 0.5;
  return [...groups].sort((a, b) => score(b) - score(a));
}

export function countGroups(groups: IssueGroup[]): Record<Tier, number> {
  const counts = { safe: 0, medium: 0, high: 0 };
  for (const group of groups) counts[group.tier] += 1;
  return counts;
}

export { expertConversion };
