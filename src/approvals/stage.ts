import type { FixResult } from "@/fixes/plan";
import type { LoadedSite } from "@/platforms/connections";
import { bareHost } from "@/platforms/connections";
import type { ChangeRequest } from "@/platforms/types";
import { createApproval, type ApprovalRecord, type ExpertItem, type ManualItem } from "./records";

export interface StageSummary {
  approval: ApprovalRecord | null;
  manual: ManualItem[];
  expert: ExpertItem[];
}

function hostOf(url: string): string {
  try {
    return bareHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

/**
 * Turns prepared fixes into an approval: publishable changes for the owner to
 * approve, manual steps the platform cannot do, and expert-only items.
 * Reads from the site but writes nothing to it.
 */
export async function stageFixes(results: FixResult[], site: LoadedSite): Promise<StageSummary> {
  const manual: ManualItem[] = [];
  const expert: ExpertItem[] = [];
  const requests: ChangeRequest[] = [];
  const issueOf = new Map<ChangeRequest, { code: string; title: string }>();

  for (const result of results) {
    const outcome = result.outcome;
    if (outcome.status === "expert-review") {
      expert.push({ issueTitle: result.title, pageUrl: result.url, reason: outcome.reason, whatIsNeeded: outcome.whatIsNeeded });
      continue;
    }
    if (outcome.status !== "ready") continue;
    for (const change of outcome.changes) {
      if (!change.request) {
        manual.push({ issueTitle: result.title, pageUrl: result.url, label: change.description, text: change.after, reason: "Needs a human decision." });
      } else if (hostOf(change.request.pageUrl) !== bareHost(site.host)) {
        manual.push({
          issueTitle: result.title,
          pageUrl: result.url,
          label: change.description,
          text: change.after,
          reason: `This page is not on the connected website (${site.host}).`,
        });
      } else {
        requests.push(change.request);
        issueOf.set(change.request, { code: result.code, title: result.title });
      }
    }
  }

  const plan = requests.length ? await site.adapter.plan(requests) : { planned: [], manual: [] };
  for (const step of plan.manual) {
    const issue = issueOf.get(step.request);
    const text = "value" in step.request ? step.request.value : "alt" in step.request ? step.request.alt : "to" in step.request ? step.request.to : step.request.href;
    manual.push({
      issueTitle: issue?.title ?? "Fix",
      pageUrl: step.request.pageUrl,
      label: step.request.kind.replace("-", " "),
      text,
      reason: step.reason,
    });
  }

  if (!plan.planned.length) return { approval: null, manual, expert };
  const approval = await createApproval({
    host: site.host,
    connectionKey: site.connectionKey,
    platformLabel: site.platformLabel,
    ...(site.siteName ? { siteName: site.siteName } : {}),
    changes: plan.planned.map((entry) => {
      const issue = issueOf.get(entry.request);
      return {
        issueCode: issue?.code ?? "",
        issueTitle: issue?.title ?? "Fix",
        pageUrl: entry.request.pageUrl,
        label: entry.label,
        before: entry.before,
        after: entry.after,
        target: entry.target,
        op: entry.op,
      };
    }),
    manual,
    expert,
  });
  return { approval, manual, expert };
}
