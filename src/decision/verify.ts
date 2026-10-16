import { expectedCtr } from "@/core/search-data";
import type { Impact, Tier } from "@/core/types";
import { getIssueDefinition } from "@/policy/catalog";
import { IMPACT_WEIGHT } from "@/policy/tiers";

/**
 * Cross-checks audit issues against real search and analytics data, so the
 * user fixes what is actually costing visibility, traffic or conversions.
 * Pure functions: the tool layer fetches the data and passes it in.
 */

export interface PageSearchMetrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** Same metrics for the previous period of equal length, when available. */
  previous?: { clicks: number; impressions: number };
}

export interface PageAnalyticsMetrics {
  sessions: number;
  engagementRate: number;
  keyEvents: number;
}

export interface IndexInspection {
  verdict?: string;
  coverageState?: string;
  googleCanonical?: string;
  userCanonical?: string;
  robotsTxtState?: string;
}

export interface VerificationData {
  search: Map<string, PageSearchMetrics>;
  analytics: Map<string, PageAnalyticsMetrics>;
  inspections: Map<string, IndexInspection>;
  /** True when GA4 recorded no key events at all (conversions not tracked). */
  keyEventsTracked: boolean;
  hasSearchData: boolean;
  hasAnalyticsData: boolean;
}

export type VerificationStatus = "confirmed" | "likely" | "not-visible-in-data" | "insufficient-data";

export interface VerifiedIssue {
  code: string;
  url: string;
  title: string;
  tier: Tier;
  impact: Impact;
  status: VerificationStatus;
  explanation: string;
  priority: number;
  evidence: {
    search?: PageSearchMetrics;
    analytics?: PageAnalyticsMetrics;
    inspection?: IndexInspection;
  };
}

export const INDEXATION_CODES = new Set([
  "technical.noindex",
  "technical.canonical.points_elsewhere",
  "technical.canonical.missing",
  "technical.canonical.multiple",
  "technical.status.error",
  "technical.robots_txt.blocks_all",
  "geo.rendering.js_dependent",
]);

const SNIPPET_CODES = /^seo\.(title|meta_description)\./;
const CONTENT_CODES = /^(seo\.content|seo\.h1|seo\.links\.few|aeo\.|geo\.content|geo\.entity|content\.|schema\.)/;
const CONVERSION_CODES = /^conversion\./;
const EXPERIENCE_CODES = /^technical\.(response|cwv|html|images|viewport|mixed_content)/;

/** Key for matching URLs across sources: path without trailing slash. */
export function pathKey(url: string): string {
  try {
    const parsed = new URL(url);
    return (parsed.pathname.replace(/\/+$/, "") || "/") + parsed.search;
  } catch {
    return (url.replace(/\/+$/, "") || "/").split("#")[0] ?? url;
  }
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function trafficWeight(search?: PageSearchMetrics, analytics?: PageAnalyticsMetrics): number {
  const volume = (search?.impressions ?? 0) / 10 + (search?.clicks ?? 0) + (analytics?.sessions ?? 0);
  return 1 + Math.log10(1 + volume);
}

const STATUS_MULTIPLIER: Record<VerificationStatus, number> = {
  confirmed: 2,
  likely: 1.3,
  "insufficient-data": 1,
  "not-visible-in-data": 0.5,
};

function judge(
  code: string,
  search: PageSearchMetrics | undefined,
  analytics: PageAnalyticsMetrics | undefined,
  inspection: IndexInspection | undefined,
  data: VerificationData,
): { status: VerificationStatus; explanation: string } {
  if (INDEXATION_CODES.has(code)) {
    if (inspection?.verdict === "FAIL" || /not indexed|excluded|blocked|noindex/i.test(inspection?.coverageState ?? "")) {
      return { status: "confirmed", explanation: `Google reports: ${inspection?.coverageState ?? "not indexed"}.` };
    }
    if (inspection?.googleCanonical && inspection.userCanonical && inspection.googleCanonical !== inspection.userCanonical) {
      return { status: "confirmed", explanation: `Google chose ${inspection.googleCanonical} as canonical instead of ${inspection.userCanonical}.` };
    }
    if (inspection?.verdict === "PASS") {
      return {
        status: "likely",
        explanation: "The URL is currently indexed. The directive may be new or not yet processed, so fix it before Google recrawls.",
      };
    }
    if (search && search.impressions === 0) return { status: "likely", explanation: "The page got no search impressions in the period." };
    return { status: "insufficient-data", explanation: "No index inspection data was available for this URL." };
  }

  if (SNIPPET_CODES.test(code)) {
    if (!search || search.impressions < 100) {
      return { status: "insufficient-data", explanation: `Only ${search?.impressions ?? 0} impressions, too few to judge click-through rate.` };
    }
    const expected = expectedCtr(search.position);
    if (search.ctr < expected * 0.5) {
      return {
        status: "confirmed",
        explanation: `${search.impressions} impressions at position ${search.position.toFixed(1)} but CTR is ${pct(search.ctr)} vs about ${pct(expected)} expected.`,
      };
    }
    return { status: "not-visible-in-data", explanation: `CTR ${pct(search.ctr)} is normal for position ${search.position.toFixed(1)}.` };
  }

  if (CONVERSION_CODES.test(code)) {
    if (!analytics || analytics.sessions < 30) {
      return { status: "insufficient-data", explanation: `Only ${analytics?.sessions ?? 0} sessions on this page in the period.` };
    }
    if (!data.keyEventsTracked) {
      return {
        status: "insufficient-data",
        explanation: `${analytics.sessions} sessions, but GA4 has no key events set up, so conversions cannot be measured.`,
      };
    }
    const rate = analytics.keyEvents / analytics.sessions;
    if (rate < 0.01) {
      return { status: "confirmed", explanation: `${analytics.sessions} sessions produced ${analytics.keyEvents} key events (${pct(rate)}).` };
    }
    if (analytics.engagementRate < 0.4) {
      return { status: "likely", explanation: `Engagement rate is low (${pct(analytics.engagementRate)}).` };
    }
    return { status: "not-visible-in-data", explanation: `Converting at ${pct(rate)} of sessions; still worth testing, but not urgent.` };
  }

  if (EXPERIENCE_CODES.test(code)) {
    if (analytics && analytics.sessions >= 30 && analytics.engagementRate < 0.5) {
      return { status: "likely", explanation: `Engagement rate is ${pct(analytics.engagementRate)} on ${analytics.sessions} sessions.` };
    }
    if (analytics && analytics.sessions >= 30) {
      return { status: "not-visible-in-data", explanation: `Engagement is healthy (${pct(analytics.engagementRate)}).` };
    }
    return { status: "insufficient-data", explanation: "Not enough analytics data for this page." };
  }

  if (CONTENT_CODES.test(code)) {
    if (search && search.impressions >= 50 && search.position > 3 && search.position <= 20) {
      return {
        status: "likely",
        explanation: `Ranks at position ${search.position.toFixed(1)} with ${search.impressions} impressions; improving this can move it up.`,
      };
    }
    if (search && search.position > 0 && search.position <= 3) {
      return { status: "not-visible-in-data", explanation: `Already ranks in the top 3 (position ${search.position.toFixed(1)}).` };
    }
    if (data.hasSearchData && (!search || search.impressions === 0)) {
      return { status: "likely", explanation: "The page gets almost no search visibility today." };
    }
  }

  if (search || analytics) {
    const parts = [
      search ? `${search.clicks} clicks / ${search.impressions} impressions` : "",
      analytics ? `${analytics.sessions} sessions` : "",
    ].filter(Boolean);
    return { status: "likely", explanation: `Affects a page with ${parts.join(", ")}.` };
  }
  return { status: "insufficient-data", explanation: "No search or analytics data matched this page." };
}

export function verifyIssues(issues: { code: string; url: string }[], data: VerificationData): VerifiedIssue[] {
  const verified: VerifiedIssue[] = [];
  for (const issue of issues) {
    const definition = getIssueDefinition(issue.code);
    if (!definition) continue;
    const key = pathKey(issue.url);
    const search = data.search.get(key);
    const analytics = data.analytics.get(key);
    const inspection = data.inspections.get(issue.url) ?? data.inspections.get(key);
    const { status, explanation } = judge(issue.code, search, analytics, inspection, data);
    verified.push({
      code: issue.code,
      url: issue.url,
      title: definition.title,
      tier: definition.tier,
      impact: definition.impact,
      status,
      explanation,
      priority: Math.round(IMPACT_WEIGHT[definition.impact] * trafficWeight(search, analytics) * STATUS_MULTIPLIER[status] * 10) / 10,
      evidence: {
        ...(search ? { search } : {}),
        ...(analytics ? { analytics } : {}),
        ...(inspection ? { inspection } : {}),
      },
    });
  }
  return verified.sort((a, b) => b.priority - a.priority);
}
