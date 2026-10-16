import * as cheerio from "cheerio";

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

export interface ParsedSitemap {
  kind: "index" | "urlset" | "unknown";
  entries: SitemapEntry[];
}

export function parseSitemap(xml: string): ParsedSitemap {
  const $ = cheerio.load(xml, { xml: true });
  const read = (selector: string): SitemapEntry[] =>
    $(selector)
      .toArray()
      .map((el) => {
        const loc = $(el).children("loc").first().text().trim();
        const lastmod = $(el).children("lastmod").first().text().trim();
        return lastmod ? { loc, lastmod } : { loc };
      })
      .filter((entry) => entry.loc);
  if ($("sitemapindex").length) return { kind: "index", entries: read("sitemap") };
  if ($("urlset").length) return { kind: "urlset", entries: read("url") };
  return { kind: "unknown", entries: [] };
}
