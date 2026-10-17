import type { Finding, Issue } from "@/core/types";
import { getIssueDefinition } from "./catalog";
import { IMPACT_PENALTY, IMPACT_WEIGHT, TIERS, TIER_ORDER } from "./tiers";

/**
 * Turns raw findings into classified issues. Unknown codes are a programming
 * error, so they throw instead of silently defaulting to a tier.
 */
export function classify(findings: Finding[]): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const finding of findings) {
    const key = `${finding.code}|${finding.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const definition = getIssueDefinition(finding.code);
    if (!definition) throw new Error(`Unknown issue code: ${finding.code}`);
    issues.push({
      ...finding,
      category: definition.category,
      tier: definition.tier,
      impact: definition.impact,
      title: definition.title,
      why: definition.why,
      recommendation: definition.recommendation,
      expertise: definition.expertise,
      fixPolicy: TIERS[definition.tier].policy,
      ...(definition.expertReason ? { expertReason: definition.expertReason } : {}),
      ...(definition.fix ? { fix: definition.fix } : {}),
    });
  }
  return sortIssues(issues);
}

/** Highest risk first, then highest impact. */
export function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const tier = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
    if (tier !== 0) return tier;
    return IMPACT_WEIGHT[b.impact] - IMPACT_WEIGHT[a.impact];
  });
}

/** Heuristic 0-100 score: each distinct issue code costs points by impact. */
export function scoreIssues(issues: Issue[]): number {
  const byCode = new Map<string, Issue>();
  for (const issue of issues) byCode.set(issue.code, issue);
  let score = 100;
  for (const issue of byCode.values()) score -= IMPACT_PENALTY[issue.impact];
  return Math.max(0, Math.min(100, score));
}

export function countByTier(issues: Issue[]): Record<"safe" | "medium" | "high", number> {
  const counts = { safe: 0, medium: 0, high: 0 };
  for (const issue of issues) counts[issue.tier] += 1;
  return counts;
}
