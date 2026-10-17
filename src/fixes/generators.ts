import type { AuditContext } from "@/core/context";
import type { PageData } from "@/core/extract";
import type { FixKind } from "@/core/types";
import { brandCandidates, comparableUrl, findBrokenInternalLinks, keywordTokens } from "@/audits/shared";
import type { ChangeRequest } from "@/platforms/types";

/**
 * Fix generators for safe (🟢) issues: content-level changes only. Each
 * returns the exact change derived from what is already on the page, plus a
 * platform-neutral `request` that a connected website can publish after the
 * owner approves it. They never invent business facts; anything uncertain is
 * flagged in `notes`.
 */

export type FixTarget = "head" | "body-element" | "image-alt" | "link";

export interface FixChange {
  target: FixTarget;
  description: string;
  before?: string;
  after: string;
  notes?: string[];
  /** Present when the change can be published through a connected platform. */
  request?: ChangeRequest;
}

export interface FixOptions {
  /** Better alt text supplied by Claude after looking at the images. */
  altText?: { src: string; alt: string }[];
}

export type FixGenerator = (page: PageData, ctx: AuditContext, options: FixOptions) => Promise<FixChange[]>;

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Trims at a word boundary without adding an ellipsis. */
export function trimToLength(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentenceEnd > max * 0.6) return cut.slice(0, sentenceEnd + 1).trim();
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:\-–—]+$/, "").trim();
}

function primaryBrand(page: PageData): string | undefined {
  return brandCandidates(page)[0];
}

/** Turns SHOUTED headings into title case so they read well in search results. */
export function readableCase(text: string): string {
  const letters = text.replace(/[^a-z]/gi, "");
  const upper = text.replace(/[^A-Z]/g, "").length;
  if (letters.length < 5 || upper / letters.length < 0.8) return text;
  const small = new Set(["a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "with", "by"]);
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => (index > 0 && small.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export function suggestTitle(page: PageData): string {
  const brand = primaryBrand(page);
  const withBrand = (topic: string) => (brand && !topic.toLowerCase().includes(brand.toLowerCase()) ? `${topic} | ${brand}` : topic);

  // A title that is only too long usually has the right topic: keep its main part.
  if (page.title && page.title.length > 60) {
    const parts = page.title.split(/\s[|\-–—:·]\s/).map((part) => part.trim()).filter(Boolean);
    const main = parts.find((part) => !brand || part.toLowerCase() !== brand.toLowerCase()) ?? parts[0] ?? page.title;
    const candidate = withBrand(main);
    return candidate.length <= 60 ? candidate : trimToLength(main, 60);
  }

  const topic = readableCase(
    page.h1s[0] ??
      page.og["og:title"] ??
      page.headings[0]?.text ??
      (page.title ? page.title.split(/\s[|\-–—]\s/)[0] : undefined) ??
      new URL(page.url).hostname,
  );
  const topicClean = brand ? topic.replace(new RegExp(`\\s*[|\\-–—:]\\s*${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), "") : topic;
  const candidate = withBrand(topicClean);
  return candidate.length <= 60 ? candidate : trimToLength(topicClean, 60);
}

/** Builds a 120-155 character description from the page's own copy where possible. */
export function suggestMetaDescription(page: PageData): string {
  if (page.metaDescription && page.metaDescription.length > 165) return trimToLength(page.metaDescription, 155);
  let source = "";
  for (const paragraph of page.paragraphs.length ? page.paragraphs : [page.text]) {
    source = source ? `${source} ${paragraph}` : paragraph;
    if (source.length >= 120) break;
  }
  if (source.length < 120 && page.h1s[0] && !/^(home|welcome)$/i.test(page.h1s[0])) source = `${page.h1s[0]}. ${source}`;
  return trimToLength(source, 155);
}

export function altFromFilename(src: string): string {
  let name: string;
  try {
    name = decodeURIComponent(new URL(src).pathname.split("/").pop() ?? "");
  } catch {
    name = src.split("/").pop() ?? "";
  }
  name = name
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[-_]\d+x\d+$/i, "")
    .replace(/[-_]?(scaled|copy|final|edited|min|thumb|thumbnail|large|small|medium|web|img|image|photo|pic)\b/gi, "")
    .replace(/[-_.+]+/g, " ")
    .replace(/\b[0-9a-f]{8,}\b/gi, "")
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.replace(/[^a-z]/gi, "").length < 4) return "";
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

function pathSimilarity(a: string, b: string): number {
  const tokens = (url: string) => {
    try {
      return new Set(keywordTokens(decodeURIComponent(new URL(url).pathname).replace(/[-_/]/g, " ")));
    } catch {
      return new Set<string>();
    }
  };
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  return shared / new Set([...left, ...right]).size;
}

const GENERATORS: Record<FixKind, FixGenerator> = {
  async title(page) {
    const after = suggestTitle(page);
    return [
      {
        target: "head",
        description: "Set the page title",
        ...(page.title ? { before: page.title } : {}),
        after,
        notes: [
          page.title && page.title.length > 60
            ? "Shortened from the current title, keeping its main topic and the brand name."
            : "Built from the page's own H1 and brand name. Adjust wording if the main keyword should come first.",
        ],
        request: { kind: "seo-title", pageUrl: page.url, value: after },
      },
    ];
  },

  async "meta-description"(page) {
    const after = suggestMetaDescription(page);
    return [
      {
        target: "head",
        description: "Set the meta description",
        ...(page.metaDescription ? { before: page.metaDescription } : {}),
        after,
        notes: [`${after.length} characters, taken from the page's own copy. Add a call to action if it fits.`],
        request: { kind: "meta-description", pageUrl: page.url, value: after },
      },
    ];
  },

  async "alt-text"(page, _ctx, options) {
    const supplied = new Map((options.altText ?? []).map((item) => [item.src, item.alt.trim()]));
    return page.images
      .filter((image) => image.alt === null)
      .slice(0, 30)
      .map((image) => {
        const fromClaude = supplied.get(image.src);
        const suggestion = fromClaude || image.context || altFromFilename(image.src);
        return {
          target: "image-alt" as const,
          description: `Add alt text to ${image.src}`,
          before: "(no alt text)",
          after: suggestion || '(needs a description, or alt="" if decorative)',
          notes: fromClaude
            ? ["Written after looking at the image."]
            : suggestion
              ? ["Suggested from the file name or caption. Check that it describes the image; Claude can look at the image and pass better alt text."]
              : ["No usable hint in the file name, so this one needs a human description."],
          ...(suggestion ? { request: { kind: "image-alt" as const, pageUrl: page.url, src: image.src, alt: suggestion } } : {}),
        };
      });
  },

  async "broken-link"(page, ctx) {
    const { findings } = await findBrokenInternalLinks(ctx, [page], 40);
    const broken = (findings[0]?.evidence?.broken ?? []) as { url: string; status: number; anchor: string }[];
    if (!broken.length) return [];
    const sitemap = await ctx.sitemap(new URL(page.url).origin);
    const candidates = [
      ...new Set([...sitemap.entries.map((entry) => entry.loc), ...page.links.filter((link) => link.internal).map((link) => link.href)]),
    ].filter((url) => !broken.some((item) => comparableUrl(item.url) === comparableUrl(url)));
    return broken.map((item) => {
      const best = candidates
        .map((url) => ({ url, score: pathSimilarity(item.url, url) }))
        .sort((a, b) => b.score - a.score)[0];
      const replacement = best && best.score >= 0.34 ? best.url : undefined;
      return {
        target: "link" as const,
        description: `Fix link "${item.anchor || item.url}" (returns ${item.status})`,
        before: item.url,
        after: replacement ?? "Remove the link (keep the text) or point it to the most relevant live page",
        notes: replacement
          ? ["Closest matching live URL by path. Confirm it is the right destination."]
          : ["No close match found among known pages, so this one needs a human decision."],
        ...(replacement ? { request: { kind: "replace-link" as const, pageUrl: page.url, from: item.url, to: replacement } } : {}),
      };
    });
  },

  async "tel-link"(page) {
    return page.phonesInText.slice(0, 5).map((phone) => {
      const href = `tel:${phone.replace(/[^\d+]/g, "")}`;
      return {
        target: "body-element" as const,
        description: `Make ${phone} tap-to-call`,
        before: phone,
        after: `<a href="${href}">${escapeHtml(phone)}</a>`,
        notes: href.startsWith("tel:+") ? [] : ["Add the country code to the tel: link (for example tel:+1...) for international callers."],
        request: { kind: "tel-link" as const, pageUrl: page.url, text: phone, href },
      };
    });
  },
};

export function fixGenerator(kind: FixKind): FixGenerator {
  return GENERATORS[kind];
}
