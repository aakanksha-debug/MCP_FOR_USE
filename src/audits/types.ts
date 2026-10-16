import type { AuditContext } from "@/core/context";
import type { AuditId, AuditResult, Finding } from "@/core/types";
import { classify, scoreIssues } from "@/policy/classify";

/** What an audit returns before policy classification. */
export interface AuditOutput {
  findings: Finding[];
  passed: string[];
  facts: Record<string, unknown>;
  notes: string[];
  askUser: string[];
}

export interface AuditModule<Input extends { url: string }> {
  id: AuditId;
  name: string;
  run(ctx: AuditContext, input: Input): Promise<AuditOutput>;
}

export function emptyOutput(): AuditOutput {
  return { findings: [], passed: [], facts: {}, notes: [], askUser: [] };
}

export function finalize(module: { id: AuditId; name: string }, target: string, output: AuditOutput): AuditResult {
  const issues = classify(output.findings);
  return {
    audit: module.id,
    name: module.name,
    target,
    checkedAt: new Date().toISOString(),
    score: scoreIssues(issues),
    issues,
    passed: output.passed,
    facts: output.facts,
    notes: output.notes,
    askUser: output.askUser,
  };
}

export async function runAudit<Input extends { url: string }>(
  module: AuditModule<Input>,
  ctx: AuditContext,
  input: Input,
): Promise<AuditResult> {
  const output = await module.run(ctx, input);
  return finalize(module, input.url, output);
}
