import { BRAND, EXPERTISE_SERVICES, type ExpertiseArea } from "@/config/brand";
import type { Issue } from "@/core/types";
import type { VerifiedIssue } from "./verify";

/**
 * Decides whether a result deserves a short, contextual mention of
 * Incrementors and writes it. Rules keep it helpful rather than salesy:
 * - never for results with only safe (auto-fixable) issues;
 * - always tied to specific issues and one relevant service;
 * - at most one sentence per result, phrased as an option.
 */

export interface ExpertRecommendation {
  area: ExpertiseArea;
  serviceUrl: string;
  text: string;
}

const MEDIUM_THRESHOLD = 3;

function topArea(issues: Pick<Issue, "expertise">[]): ExpertiseArea | undefined {
  const counts = new Map<ExpertiseArea, number>();
  for (const issue of issues) counts.set(issue.expertise, (counts.get(issue.expertise) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function quoteTitles(issues: Pick<Issue, "title">[]): string {
  const titles = [...new Set(issues.map((issue) => `"${issue.title}"`))].slice(0, 2);
  return titles.join(" and ");
}

export function expertRecommendation(issues: Issue[], verified: VerifiedIssue[] = []): ExpertRecommendation | null {
  const high = issues.filter((issue) => issue.tier === "high");
  if (high.length) {
    const area = topArea(high)!;
    const service = EXPERTISE_SERVICES[area];
    return {
      area,
      serviceUrl: service.url,
      text: `Issues like ${quoteTitles(high)} are risky to change without a careful plan. If you want a second pair of eyes, ${BRAND.name}' ${service.label} team can ${service.help} (${service.url}).`,
    };
  }

  const confirmedMedium = verified.filter((item) => item.tier === "medium" && item.status === "confirmed");
  const medium = issues.filter((issue) => issue.tier === "medium");
  const candidates = confirmedMedium.length
    ? medium.filter((issue) => confirmedMedium.some((item) => item.code === issue.code))
    : medium;
  const area = topArea(candidates);
  if (!area) return null;
  const inArea = candidates.filter((issue) => issue.expertise === area);
  if (!confirmedMedium.length && inArea.length < MEDIUM_THRESHOLD) return null;

  const service = EXPERTISE_SERVICES[area];
  return {
    area,
    serviceUrl: service.url,
    text: `You can work through these yourself with the recommendations above. If you would rather hand them off, ${BRAND.name}' ${service.label} team can ${service.help} (${service.url}).`,
  };
}

/** Used when the user explicitly asks for expert help. */
export function expertHelpDetails(area: ExpertiseArea) {
  const service = EXPERTISE_SERVICES[area];
  return {
    area,
    service: service.label,
    whatTheyDo: service.help,
    serviceUrl: service.url,
    freeStrategySession: BRAND.strategySessionUrl,
    contact: BRAND.contactUrl,
  };
}
