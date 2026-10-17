import type { AuditContext } from "@/core/context";
import type { PageData } from "@/core/extract";
import { mapLimit } from "@/core/concurrency";
import type { Finding } from "@/core/types";
import { normalizeTargetUrl } from "@/core/url-guard";

export class AuditTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditTargetError";
  }
}

const ASSET_EXTENSION = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|zip|rar|gz|mp4|mp3|mov|avi|webm|woff2?|ttf|eot|docx?|xlsx?|pptx?|csv)(?:$|\?)/i;
const SKIP_PATH = /\/(wp-admin|wp-login|cart|checkout|my-account|account|login|signin|sign-in|logout|feed|tag|author|page\/\d+)(?:\/|$)/i;

/** Comparable form of a URL: lowercase host, no hash, no trailing slash. */
export function comparableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    let path = parsed.pathname.replace(/\/+$/, "");
    if (!path) path = "";
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Pages that are normally kept out of search results on purpose. */
const NOT_FOR_SEARCH = /\/(search|cart|basket|checkout|my-account|account|login|log-in|signin|sign-in|register|signup|sign-up|logout|thank-you|thankyou|thanks|wp-admin|wp-login\.php|feed|preview)(\/|$|\?)|[?&](s|q|search)=/i;

export function isNotForSearch(url: string): boolean {
  return NOT_FOR_SEARCH.test(url);
}

export function isNoindex(page: { robotsMeta?: string; xRobotsTag?: string }): boolean {
  return `${page.robotsMeta ?? ""} ${page.xRobotsTag ?? ""}`.toLowerCase().includes("noindex");
}

export function isHomepage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.pathname === "/" || parsed.pathname === "") && !parsed.search;
  } catch {
    return false;
  }
}

export function isCrawlablePageUrl(url: string): boolean {
  return !ASSET_EXTENSION.test(url) && !SKIP_PATH.test(url) && !/[?&](replytocom|add-to-cart|s)=/i.test(url);
}

/**
 * Loads the audit target. Throws AuditTargetError (shown to the user) when the
 * site cannot be reached at all; HTTP error statuses are returned for audits
 * to report.
 */
export async function loadTarget(ctx: AuditContext, rawUrl: string): Promise<{ url: string; page: PageData }> {
  const url = normalizeTargetUrl(rawUrl).toString();
  const page = await ctx.page(url);
  if (page.status === 0) {
    throw new AuditTargetError(`Could not reach ${url}${page.error ? ` (${page.error})` : ""}. Check the URL and that the site is online.`);
  }
  return { url, page };
}

/** Picks internal pages to sample: navigation links first, then body links, then the sitemap. */
export async function pickSamplePages(ctx: AuditContext, home: PageData, max: number): Promise<string[]> {
  if (max <= 0) return [];
  const homeKey = comparableUrl(home.url);
  const picked: string[] = [];
  const seen = new Set<string>([homeKey]);
  const consider = (url: string) => {
    if (picked.length >= max) return;
    const key = comparableUrl(url.split("#")[0] ?? url);
    if (seen.has(key) || !isCrawlablePageUrl(url)) return;
    seen.add(key);
    picked.push(url.split("#")[0] ?? url);
  };
  const internal = home.links.filter((link) => link.internal && !link.rel.includes("nofollow"));
  for (const link of internal.filter((l) => l.inHeader)) consider(link.href);
  for (const link of internal.filter((l) => !l.inHeader && !l.inFooter)) consider(link.href);
  if (picked.length < max) {
    const sitemap = await ctx.sitemap(new URL(home.url).origin);
    for (const entry of sitemap.entries) consider(entry.loc);
  }
  for (const link of internal.filter((l) => l.inFooter)) consider(link.href);
  return picked;
}

export async function loadPages(ctx: AuditContext, urls: string[]): Promise<PageData[]> {
  const pages = await mapLimit(urls, 5, (url) => (ctx.timeLeftMs() > 6_000 ? ctx.page(url) : Promise.resolve(null)));
  return pages.filter((page): page is PageData => page !== null);
}

export function isOkHtml(page: PageData): boolean {
  return page.isHtml && page.status >= 200 && page.status < 300;
}

/**
 * Checks internal links found on the given pages and returns one finding per
 * page that links to a broken URL (404/410/5xx).
 */
export async function findBrokenInternalLinks(
  ctx: AuditContext,
  pages: PageData[],
  limit: number,
): Promise<{ findings: Finding[]; checked: number; unreachable: number }> {
  const sources = new Map<string, { page: string; text: string }[]>();
  for (const page of pages) {
    for (const link of page.links) {
      if (!link.internal || !isCrawlablePageUrl(link.href)) continue;
      const target = link.href.split("#")[0] ?? link.href;
      if (comparableUrl(target) === comparableUrl(page.url)) continue;
      const list = sources.get(target) ?? [];
      list.push({ page: page.url, text: link.text });
      sources.set(target, list);
    }
  }
  const knownStatuses = new Map(pages.map((page) => [page.url, page.status]));
  const toCheck = [...sources.keys()].filter((url) => !knownStatuses.has(url));
  const statuses = await ctx.checkLinks(toCheck, limit);
  for (const [url, status] of knownStatuses) statuses.set(url, status);

  const byPage = new Map<string, { url: string; status: number; anchor: string }[]>();
  let unreachable = 0;
  for (const [target, status] of statuses) {
    if (status === 0) unreachable += 1;
    if (!(status === 404 || status === 410 || status >= 500)) continue;
    for (const source of sources.get(target) ?? []) {
      const list = byPage.get(source.page) ?? [];
      if (!list.some((item) => item.url === target)) list.push({ url: target, status, anchor: source.text });
      byPage.set(source.page, list);
    }
  }
  const findings: Finding[] = [...byPage.entries()].map(([page, broken]) => ({
    code: "seo.links.broken_internal",
    url: page,
    detail: `${broken.length} broken internal link${broken.length === 1 ? "" : "s"}: ${broken
      .slice(0, 5)
      .map((item) => `${item.url} (${item.status})`)
      .join(", ")}`,
    evidence: { broken: broken.slice(0, 20) },
  }));
  return { findings, checked: statuses.size, unreachable };
}

/** Brand names a site uses for itself, for consistency and keyword checks. */
export function brandCandidates(page: PageData): string[] {
  const names = new Set<string>();
  if (page.siteName) names.add(page.siteName);
  for (const block of page.jsonLd) {
    const nodes = Array.isArray(block.data) ? block.data : [block.data];
    for (const node of nodes) {
      const graph = (node as { "@graph"?: unknown[] })?.["@graph"];
      for (const item of Array.isArray(graph) ? graph : [node]) {
        const record = item as Record<string, unknown> | undefined;
        const type = record?.["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (types.some((t) => typeof t === "string" && /Organization|LocalBusiness|WebSite|Corporation/.test(t))) {
          if (typeof record?.name === "string") names.add(record.name);
        }
      }
    }
  }
  // The title suffix is only a guess (it is often a tagline), so use it when nothing better exists.
  if (!names.size) {
    const titleParts = (page.title ?? "").split(/\s[|\-–—:·]\s/);
    const last = titleParts.length > 1 ? titleParts[titleParts.length - 1]?.trim() : undefined;
    if (last && last.split(/\s+/).length <= 5) names.add(last);
  }
  return [...names].map((name) => name.trim()).filter(Boolean);
}

export function normalizeBrand(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(inc|llc|ltd|limited|co|corp|corporation|pvt|plc|gmbh)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function digitsOnly(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i in is it me my of on or our should the to was we what when where which who why will with you your near best".split(
    " ",
  ),
);

export function keywordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
    .map((word) => word.replace(/(ing|ed|es|s)$/, ""));
}

/** Share (0-1) of the query's keywords that appear in the text. */
export function keywordCoverage(query: string, text: string): number {
  const tokens = keywordTokens(query);
  if (!tokens.length) return 1;
  const haystack = new Set(keywordTokens(text));
  return tokens.filter((token) => haystack.has(token)).length / tokens.length;
}
