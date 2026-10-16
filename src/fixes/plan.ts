import type { AuditContext } from "@/core/context";
import type { PageData } from "@/core/extract";
import type { Tier } from "@/core/types";
import { normalizeTargetUrl } from "@/core/url-guard";
import { getIssueDefinition } from "@/policy/catalog";
import { aeoFindings } from "@/audits/aeo";
import { pageSchemaFindings } from "@/audits/schema";
import { pageSeoFindings } from "@/audits/seo-health";
import { isOkHtml } from "@/audits/shared";
import { draftFor, type Draft } from "./drafts";
import { fixGenerator, type FixChange } from "./generators";
import { whereToApply, type Platform } from "./platforms";

/**
 * Enforces the three-tier change policy server-side:
 * 🟢 safe   → exact fix prepared
 * 🟡 medium → proposal only, unless the user approved the issue code
 * 🔴 high   → never fixed; expert review recommended
 */

export interface FixRequestItem {
  code: string;
  url: string;
}

export type FixOutcome =
  | { status: "ready"; changes: (FixChange & { whereToApply: string })[] }
  | { status: "needs-approval"; proposal: string }
  | { status: "draft"; draft: Draft }
  | { status: "expert-review"; reason: string }
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
const SITE_FILE = /^\/(robots\.txt|llms\.txt|[\w-]*sitemap[\w-]*\.xml)$/i;

/** Codes whose presence can be re-checked on a single page. */
function presentCodes(page: PageData): Set<string> {
  const codes = new Set<string>();
  for (const finding of pageSeoFindings(page)) codes.add(finding.code);
  for (const finding of pageSchemaFindings(page).findings) codes.add(finding.code);
  for (const finding of aeoFindings(page).findings) codes.add(finding.code);
  if (!page.lang) codes.add("technical.lang.missing");
  if (page.phonesInText.length && !page.telLinks.length) codes.add("conversion.phone.not_clickable");
  return codes;
}

const RECHECKABLE = /^(seo\.(title|meta_description|images|open_graph)|schema\.|aeo\.faq_schema|technical\.lang|conversion\.phone\.not_clickable)/;

export async function prepareFixes(
  ctx: AuditContext,
  items: FixRequestItem[],
  options: { approvedCodes?: string[]; platform?: Platform } = {},
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
          reason: `${definition.recommendation} This is a high-risk change, so it is not prepared automatically.`,
        },
      });
      continue;
    }

    let url: string;
    try {
      const target = normalizeTargetUrl(item.url);
      // Site-level issues are reported on the file URL; fixes are built from the homepage.
      url = SITE_FILE.test(target.pathname) ? `${target.origin}/` : target.toString();
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
      if (!approved.has(item.code)) {
        results.push({ ...base, outcome: { status: "needs-approval", proposal: definition.recommendation } });
      } else {
        results.push({ ...base, outcome: { status: "draft", draft: draftFor(item.code, page, definition.recommendation) } });
      }
      continue;
    }

    // Safe tier: confirm the issue still exists, then generate the exact fix.
    if (RECHECKABLE.test(item.code) && !presentCodes(page).has(item.code)) {
      results.push({ ...base, outcome: { status: "not-detected", reason: "The issue was not found on the page now; it may already be fixed." } });
      continue;
    }
    if (!definition.fix) {
      results.push({ ...base, outcome: { status: "needs-approval", proposal: definition.recommendation } });
      continue;
    }
    try {
      const changes = await fixGenerator(definition.fix)(page, ctx);
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

