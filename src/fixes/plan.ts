import type { AuditContext } from "@/core/context";
import type { PageData } from "@/core/extract";
import type { Tier } from "@/core/types";
import { normalizeTargetUrl } from "@/core/url-guard";
import { BRAND } from "@/config/brand";
import { getIssueDefinition } from "@/policy/catalog";
import { pageSeoFindings } from "@/audits/seo-health";
import { isOkHtml } from "@/audits/shared";
import { draftFor, type Draft } from "./drafts";
import { fixGenerator, type FixChange, type FixOptions } from "./generators";
import { whereToApply, type Platform } from "./where-to-apply";

/**
 * Enforces the change policy server-side:
 * 🟢 safe   → exact content fix prepared (published only after owner approval)
 * 🟡 medium → proposal only, unless the user approved the issue code
 * 🔴 high   → never fixed: high-risk, or needs plugin/theme/code/server work
 */

export interface FixRequestItem {
  code: string;
  url: string;
}

export type FixOutcome =
  | { status: "ready"; changes: (FixChange & { whereToApply: string })[] }
  | { status: "needs-approval"; proposal: string }
  | { status: "draft"; draft: Draft }
  | { status: "expert-review"; reason: string; whatIsNeeded: string }
  | { status: "not-detected"; reason: string }
  | { status: "error"; reason: string };

export interface FixResult {
  code: string;
  url: string;
  title: string;
  tier: Tier | "unknown";
  outcome: FixOutcome;
}

const MAX_PAGES = 5;

/** Safe issues whose presence can be re-checked on the page before fixing. */
const RECHECKABLE = /^(seo\.(title|meta_description|images)|conversion\.phone\.not_clickable)/;

function stillPresent(code: string, page: PageData): boolean {
  if (code === "conversion.phone.not_clickable") return page.phonesInText.length > 0 && page.telLinks.length === 0;
  return pageSeoFindings(page).some((finding) => finding.code === code);
}

export function expertWarning(reason: string): string {
  return `⚠️ Needs expert advice: ${reason}. The MCP will not make this change, because done wrong it can break the site or hurt rankings. Contact an ${BRAND.strategistLabel}: ${BRAND.strategySessionUrl}`;
}

export async function prepareFixes(
  ctx: AuditContext,
  items: FixRequestItem[],
  options: { approvedCodes?: string[]; platform?: Platform } & FixOptions = {},
): Promise<FixResult[]> {
  const approved = new Set(options.approvedCodes ?? []);
  const platform = options.platform ?? "html";
  const pages = new Map<string, Promise<PageData>>();
  const results: FixResult[] = [];

  for (const item of items) {
    const definition = getIssueDefinition(item.code);
    if (!definition) {
      results.push({ ...item, title: item.code, tier: "unknown", outcome: { status: "error", reason: "Unknown issue code." } });
      continue;
    }
    const base = { code: item.code, url: item.url, title: definition.title, tier: definition.tier };

    if (definition.tier === "high") {
      results.push({
        ...base,
        outcome: {
          status: "expert-review",
          reason: expertWarning(definition.expertReason ?? "High-risk change"),
          whatIsNeeded: definition.recommendation,
        },
      });
      continue;
    }

    let url: string;
    try {
      url = normalizeTargetUrl(item.url).toString();
    } catch (error) {
      results.push({ ...base, outcome: { status: "error", reason: (error as Error).message } });
      continue;
    }
    if (!pages.has(url) && pages.size >= MAX_PAGES) {
      results.push({ ...base, outcome: { status: "error", reason: `Fixes are limited to ${MAX_PAGES} pages per request.` } });
      continue;
    }
    if (!pages.has(url)) pages.set(url, ctx.page(url));
    const page = await pages.get(url)!;
    if (!isOkHtml(page)) {
      results.push({ ...base, outcome: { status: "error", reason: `Page returned HTTP ${page.status}.` } });
      continue;
    }

    if (definition.tier === "medium") {
      results.push({
        ...base,
        outcome: approved.has(item.code)
          ? { status: "draft", draft: draftFor(item.code, page, definition.recommendation) }
          : { status: "needs-approval", proposal: definition.recommendation },
      });
      continue;
    }

    // Safe tier: confirm the issue still exists, then generate the exact fix.
    if (RECHECKABLE.test(item.code) && !stillPresent(item.code, page)) {
      results.push({ ...base, outcome: { status: "not-detected", reason: "The issue was not found on the page now; it may already be fixed." } });
      continue;
    }
    if (!definition.fix) {
      results.push({ ...base, outcome: { status: "needs-approval", proposal: definition.recommendation } });
      continue;
    }
    try {
      const changes = await fixGenerator(definition.fix)(page, ctx, options.altText ? { altText: options.altText } : {});
      results.push(
        changes.length
          ? { ...base, outcome: { status: "ready", changes: changes.map((change) => ({ ...change, whereToApply: whereToApply(platform, change.target) })) } }
          : { ...base, outcome: { status: "not-detected", reason: "Nothing to change was found on the page." } },
      );
    } catch (error) {
      results.push({ ...base, outcome: { status: "error", reason: (error as Error).message } });
    }
  }
  return results;
}
