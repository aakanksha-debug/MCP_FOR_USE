import type { AuditContext } from "@/core/context";
import type { SearchRow } from "@/core/search-data";
import type { AuditId, AuditResult, Issue } from "@/core/types";
import { sortIssues } from "@/policy/classify";
import { aeoAudit } from "./aeo";
import { contentOpportunityAudit } from "./content-opportunity";
import { conversionAudit } from "./conversion";
import { gbpAudit, type GbpProfileDetails } from "./gbp";
import { geoAudit } from "./geo";
import { schemaAudit } from "./schema";
import { seoHealthAudit } from "./seo-health";
import { technicalAudit } from "./technical";
import { runAudit } from "./types";

export { aeoAudit, contentOpportunityAudit, conversionAudit, gbpAudit, geoAudit, schemaAudit, seoHealthAudit, technicalAudit };
export { AuditTargetError } from "./shared";

export const AUDIT_NAMES: Record<AuditId, string> = {
  seo: seoHealthAudit.name,
  technical: technicalAudit.name,
  schema: schemaAudit.name,
  aeo: aeoAudit.name,
  geo: geoAudit.name,
  conversion: conversionAudit.name,
  gbp: gbpAudit.name,
  content: contentOpportunityAudit.name,
};

export const ALL_AUDITS: AuditId[] = ["seo", "technical", "schema", "aeo", "geo", "conversion", "gbp", "content"];

export interface FullAuditInput {
  url: string;
  checks?: AuditId[];
  questions?: string[];
  priorityTopics?: string[];
  gbpProfile?: GbpProfileDetails;
  searchRows?: SearchRow[];
}

export interface FullAuditResult {
  target: string;
  checkedAt: string;
  overallScore: number;
  results: AuditResult[];
  issues: Issue[];
  errors: { audit: AuditId; message: string }[];
}

/** Runs the selected audits in parallel over one shared, memoized context. */
export async function runFullAudit(ctx: AuditContext, input: FullAuditInput): Promise<FullAuditResult> {
  const checks = input.checks?.length ? [...new Set(input.checks)] : ALL_AUDITS;
  const runners: Record<AuditId, () => Promise<AuditResult>> = {
    seo: () => runAudit(seoHealthAudit, ctx, { url: input.url, maxPages: 4 }),
    technical: () => runAudit(technicalAudit, ctx, { url: input.url }),
    schema: () => runAudit(schemaAudit, ctx, { url: input.url, maxPages: 2 }),
    aeo: () => runAudit(aeoAudit, ctx, { url: input.url, ...(input.questions ? { questions: input.questions } : {}) }),
    geo: () => runAudit(geoAudit, ctx, { url: input.url }),
    conversion: () => runAudit(conversionAudit, ctx, { url: input.url }),
    gbp: () => runAudit(gbpAudit, ctx, { url: input.url, ...(input.gbpProfile ? { profile: input.gbpProfile } : {}) }),
    content: () =>
      runAudit(contentOpportunityAudit, ctx, {
        url: input.url,
        maxPages: 5,
        ...(input.priorityTopics ? { priorityTopics: input.priorityTopics } : {}),
        ...(input.searchRows ? { searchRows: input.searchRows } : {}),
      }),
  };

  const settled = await Promise.allSettled(checks.map((id) => runners[id]()));
  const results: AuditResult[] = [];
  const errors: FullAuditResult["errors"] = [];
  settled.forEach((outcome, index) => {
    const audit = checks[index]!;
    if (outcome.status === "fulfilled") results.push(outcome.value);
    else errors.push({ audit, message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  });

  const merged = new Map<string, Issue>();
  for (const result of results) for (const issue of result.issues) merged.set(`${issue.code}|${issue.url}`, issue);
  const overallScore = results.length ? Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length) : 0;

  return {
    target: input.url,
    checkedAt: new Date().toISOString(),
    overallScore,
    results,
    issues: sortIssues([...merged.values()]),
    errors,
  };
}
