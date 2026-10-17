import { mapLimit } from "./concurrency";
import { extractPage, type PageData } from "./extract";
import { safeFetch, type Fetcher, type FetchResult } from "./http";
import { parseRobotsTxt, type RobotsTxt } from "./robots";
import { parseSitemap, type SitemapEntry } from "./sitemap";

export interface RobotsInfo {
  url: string;
  found: boolean;
  status: number;
  parsed: RobotsTxt;
}

export interface SitemapInfo {
  found: boolean;
  /** Sitemap URLs that were read successfully. */
  sources: string[];
  listedInRobots: boolean;
  entries: SitemapEntry[];
}

/**
 * Per-tool-call state: memoized fetches and a time budget. A fresh context is
 * created for every MCP tool call, so nothing is shared between users.
 */
export interface AuditContext {
  fetch: Fetcher;
  page(url: string): Promise<PageData>;
  robots(origin: string): Promise<RobotsInfo>;
  sitemap(origin: string): Promise<SitemapInfo>;
  /** HTTP status for each URL (0 = network error). Skips URLs once the budget runs low. */
  checkLinks(urls: string[], limit: number): Promise<Map<string, number>>;
  timeLeftMs(): number;
}

export interface AuditContextOptions {
  fetcher?: Fetcher;
  /** Total time budget for the tool call. Vercel functions here allow 60s. */
  budgetMs?: number;
}

const SITEMAP_ENTRY_LIMIT = 1000;

export function createAuditContext(options: AuditContextOptions = {}): AuditContext {
  const fetcher = options.fetcher ?? safeFetch;
  const deadline = Date.now() + (options.budgetMs ?? 45_000);
  const getCache = new Map<string, Promise<FetchResult>>();
  const pageCache = new Map<string, Promise<PageData>>();
  const robotsCache = new Map<string, Promise<RobotsInfo>>();
  const sitemapCache = new Map<string, Promise<SitemapInfo>>();
  const timeLeftMs = () => deadline - Date.now();

  const cachedFetch: Fetcher = (url, fetchOptions = {}) => {
    if ((fetchOptions.method ?? "GET") !== "GET" || fetchOptions.followRedirects === false || fetchOptions.headers) {
      return fetcher(url, fetchOptions);
    }
    const key = `${url}|${fetchOptions.maxBytes ?? ""}|${fetchOptions.accept ?? ""}`;
    let pending = getCache.get(key);
    if (!pending) {
      pending = fetcher(url, fetchOptions);
      getCache.set(key, pending);
    }
    return pending;
  };

  const page = (url: string) => {
    let pending = pageCache.get(url);
    if (!pending) {
      pending = cachedFetch(url).then(extractPage);
      pageCache.set(url, pending);
    }
    return pending;
  };

  const robots = (origin: string) => {
    let pending = robotsCache.get(origin);
    if (!pending) {
      const url = `${origin}/robots.txt`;
      pending = cachedFetch(url, { accept: "text/plain,*/*;q=0.5", maxBytes: 512 * 1024 }).then((result) => {
        const isText = result.ok && !/^\s*</.test(result.body);
        return {
          url,
          found: isText,
          status: result.status,
          parsed: isText ? parseRobotsTxt(result.body) : { groups: [], sitemaps: [] },
        };
      });
      robotsCache.set(origin, pending);
    }
    return pending;
  };

  const readSitemap = async (url: string) => {
    const result = await cachedFetch(url, { accept: "application/xml,text/xml,*/*;q=0.5", maxBytes: 5 * 1024 * 1024 });
    if (!result.ok || !/<(urlset|sitemapindex)/i.test(result.body.slice(0, 5000))) return null;
    return parseSitemap(result.body);
  };

  const sitemap = (origin: string) => {
    let pending = sitemapCache.get(origin);
    if (!pending) {
      pending = (async (): Promise<SitemapInfo> => {
        const robotsInfo = await robots(origin);
        const fromRobots = robotsInfo.parsed.sitemaps;
        const candidates = [
          ...fromRobots,
          `${origin}/sitemap.xml`,
          `${origin}/sitemap_index.xml`,
          `${origin}/wp-sitemap.xml`,
        ].filter((url, index, list) => list.indexOf(url) === index);

        for (const candidate of candidates.slice(0, 5)) {
          if (timeLeftMs() < 5_000) break;
          const parsed = await readSitemap(candidate);
          if (!parsed || parsed.entries.length === 0) continue;
          const sources = [candidate];
          let entries = parsed.entries;
          if (parsed.kind === "index") {
            entries = [];
            const children = parsed.entries.slice(0, 4);
            const childResults = await mapLimit(children, 4, (child) => readSitemap(child.loc));
            childResults.forEach((child, index) => {
              if (child?.kind === "urlset") {
                sources.push(children[index]!.loc);
                entries.push(...child.entries);
              }
            });
          }
          return {
            found: true,
            sources,
            listedInRobots: fromRobots.length > 0,
            entries: entries.slice(0, SITEMAP_ENTRY_LIMIT),
          };
        }
        return { found: false, sources: [], listedInRobots: fromRobots.length > 0, entries: [] };
      })();
      sitemapCache.set(origin, pending);
    }
    return pending;
  };

  const checkLinks = async (urls: string[], limit: number) => {
    const unique = [...new Set(urls)].slice(0, limit);
    const statuses = new Map<string, number>();
    await mapLimit(unique, 6, async (url) => {
      if (timeLeftMs() < 4_000) return;
      let result = await fetcher(url, { method: "HEAD", timeoutMs: 8_000 });
      if (result.status === 0 || result.status === 403 || result.status === 405 || result.status === 501) {
        result = await cachedFetch(url, { maxBytes: 64 * 1024 });
      }
      statuses.set(url, result.status);
    });
    return statuses;
  };

  return { fetch: cachedFetch, page, robots, sitemap, checkLinks, timeLeftMs };
}

export function originOf(url: string): string {
  return new URL(url).origin;
}
