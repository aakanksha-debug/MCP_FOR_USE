import type { PageData } from "@/core/extract";
import type { Finding } from "@/core/types";
import {
  comparableUrl,
  findBrokenInternalLinks,
  isHomepage,
  isOkHtml,
  loadPages,
  loadTarget,
  pickSamplePages,
} from "./shared";
import { emptyOutput, type AuditModule } from "./types";

export interface SeoHealthInput {
  url: string;
  /** Pages to check including the start page (1-15). */
  maxPages?: number;
}

const UTILITY_PAGE = /\/(contact|privacy|terms|legal|cookie|disclaimer|refund|login|cart|checkout|thank)/i;

export function pageSeoFindings(page: PageData): Finding[] {
  const findings: Finding[] = [];
  const add = (code: string, detail?: string, evidence?: Record<string, unknown>) =>
    findings.push({ code, url: page.url, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) });

  if (!page.title) add("seo.title.missing");
  else if (page.title.length > 60) add("seo.title.too_long", `${page.title.length} characters: "${page.title}"`, { title: page.title });
  else if (page.title.length < 25) add("seo.title.too_short", `${page.title.length} characters: "${page.title}"`, { title: page.title });

  if (!page.metaDescription) add("seo.meta_description.missing");
  else if (page.metaDescription.length < 70 || page.metaDescription.length > 165) {
    add("seo.meta_description.length", `${page.metaDescription.length} characters`, { description: page.metaDescription });
  }

  if (page.h1s.length === 0) add("seo.h1.missing");
  else if (page.h1s.length > 1) add("seo.h1.multiple", `${page.h1s.length} H1s: ${page.h1s.slice(0, 3).map((h) => `"${h}"`).join(", ")}`);

  const missingAlt = page.images.filter((image) => image.alt === null);
  if (missingAlt.length) {
    add("seo.images.missing_alt", `${missingAlt.length} of ${page.images.length} images have no alt attribute`, {
      images: missingAlt.slice(0, 25).map((image) => ({ src: image.src, ...(image.context ? { context: image.context } : {}) })),
    });
  }

  if (page.wordCount < 250 && !UTILITY_PAGE.test(page.url)) add("seo.content.thin", `About ${page.wordCount} words of main content`);

  const internalTargets = new Set(page.links.filter((link) => link.internal).map((link) => comparableUrl(link.href)));
  if (internalTargets.size < 3) add("seo.links.few_internal", `${internalTargets.size} unique internal links`);

  if (!page.og["og:title"] && !page.og["og:image"]) add("seo.open_graph.missing");

  const robots = `${page.robotsMeta ?? ""} ${page.xRobotsTag ?? ""}`.toLowerCase();
  if (robots.includes("noindex")) add("technical.noindex", `robots directive: "${robots.trim()}"`);

  const canonical = page.canonicals[0];
  if (canonical && comparableUrl(canonical) !== comparableUrl(page.url)) {
    add("technical.canonical.points_elsewhere", `Canonical: ${canonical}`, { canonical });
  }

  if (!isHomepage(page.url)) {
    const { pathname, searchParams } = new URL(page.url);
    const reasons: string[] = [];
    if (/[A-Z]/.test(pathname)) reasons.push("uppercase letters");
    if (pathname.includes("_")) reasons.push("underscores");
    if (page.url.length > 115) reasons.push(`${page.url.length} characters long`);
    if ([...searchParams.keys()].length >= 3) reasons.push("many query parameters");
    if (reasons.length) add("seo.url.unfriendly", reasons.join(", "));
  }
  return findings;
}

function duplicates(pages: PageData[], pick: (page: PageData) => string | undefined): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const page of pages) {
    const value = pick(page)?.trim().toLowerCase();
    if (!value) continue;
    groups.set(value, [...(groups.get(value) ?? []), page.url]);
  }
  return new Map([...groups].filter(([, urls]) => urls.length > 1));
}

export const seoHealthAudit: AuditModule<SeoHealthInput> = {
  id: "seo",
  name: "SEO Health",
  async run(ctx, input) {
    const output = emptyOutput();
    const { page: home } = await loadTarget(ctx, input.url);
    const maxPages = Math.min(Math.max(input.maxPages ?? 5, 1), 15);
    const sampleUrls = await pickSamplePages(ctx, home, maxPages - 1);
    const pages = [home, ...(await loadPages(ctx, sampleUrls))];
    const okPages = pages.filter(isOkHtml);

    for (const page of pages) {
      if (page.status >= 400) {
        output.findings.push({ code: "technical.status.error", url: page.url, detail: `HTTP ${page.status}` });
      }
    }
    for (const page of okPages) output.findings.push(...pageSeoFindings(page));

    for (const [title, urls] of duplicates(okPages, (page) => page.title)) {
      for (const url of urls) {
        output.findings.push({ code: "seo.title.duplicate", url, detail: `"${title}" is used on ${urls.length} pages`, evidence: { pages: urls } });
      }
    }
    for (const [, urls] of duplicates(okPages, (page) => page.metaDescription)) {
      for (const url of urls) {
        output.findings.push({ code: "seo.meta_description.duplicate", url, detail: `Same description on ${urls.length} pages`, evidence: { pages: urls } });
      }
    }

    const broken = await findBrokenInternalLinks(ctx, okPages, 25);
    output.findings.push(...broken.findings);

    const codes = new Set(output.findings.map((finding) => finding.code));
    if (!codes.has("seo.title.missing") && !codes.has("seo.title.too_long") && !codes.has("seo.title.too_short")) {
      output.passed.push("Titles are present and well-sized on all checked pages");
    }
    if (!codes.has("seo.meta_description.missing")) output.passed.push("Every checked page has a meta description");
    if (!codes.has("seo.h1.missing") && !codes.has("seo.h1.multiple")) output.passed.push("Each checked page has exactly one H1");
    if (!codes.has("seo.links.broken_internal")) output.passed.push(`No broken internal links among ${broken.checked} checked`);
    if (!codes.has("technical.noindex")) output.passed.push("No checked page is set to noindex");

    output.facts = {
      pagesChecked: pages.map((page) => ({ url: page.url, status: page.status, title: page.title, words: page.wordCount })),
      linksChecked: broken.checked,
    };
    if (broken.unreachable) output.notes.push(`${broken.unreachable} links could not be checked (timeouts or blocked requests).`);
    if (pages.length < maxPages) output.notes.push(`Checked ${pages.length} pages (fewer internal pages were found or the time budget ran out).`);
    return output;
  },
};
