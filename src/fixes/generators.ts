import type { AuditContext } from "@/core/context";
import type { PageData } from "@/core/extract";
import type { FixKind } from "@/core/types";
import { brandCandidates, comparableUrl, findBrokenInternalLinks, keywordTokens } from "@/audits/shared";
import { topLevelNodes } from "@/audits/schema";

/**
 * Fix generators for safe (🟢) issues. Each returns exact, ready-to-apply
 * changes derived from what is already on the page. They never invent
 * business facts; anything uncertain is flagged in `notes` for the user.
 */

export type FixTarget = "head" | "html-tag" | "body-element" | "json-ld" | "robots.txt" | "llms.txt" | "image-alt" | "link";

export interface FixChange {
  target: FixTarget;
  description: string;
  before?: string;
  after: string;
  notes?: string[];
}

export type FixGenerator = (page: PageData, ctx: AuditContext) => Promise<FixChange[]>;

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

export function suggestTitle(page: PageData): string {
  const brand = primaryBrand(page);
  const topic =
    page.h1s[0] ??
    page.og["og:title"] ??
    page.headings[0]?.text ??
    (page.title ? page.title.split(/\s[|\-–—]\s/)[0] : undefined) ??
    new URL(page.url).hostname;
  const topicClean = brand ? topic.replace(new RegExp(`\\s*[|\\-–—:]\\s*${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), "") : topic;
  const withBrand = brand && !topicClean.toLowerCase().includes(brand.toLowerCase()) ? `${topicClean} | ${brand}` : topicClean;
  if (withBrand.length <= 60) return withBrand;
  return trimToLength(topicClean, 60);
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

function jsonLdScript(data: unknown): string {
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;
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
        ...(page.title ? { before: `<title>${escapeHtml(page.title)}</title>` } : {}),
        after: `<title>${escapeHtml(after)}</title>`,
        notes: ["Built from the page's own H1 and brand name. Adjust wording if the main keyword should come first."],
      },
    ];
  },

  async "meta-description"(page) {
    const after = suggestMetaDescription(page);
    return [
      {
        target: "head",
        description: "Set the meta description",
        ...(page.metaDescription ? { before: `<meta name="description" content="${escapeHtml(page.metaDescription)}">` } : {}),
        after: `<meta name="description" content="${escapeHtml(after)}">`,
        notes: [`${after.length} characters, taken from the page's own copy. Add a call to action if it fits.`],
      },
    ];
  },

  async "alt-text"(page) {
    return page.images
      .filter((image) => image.alt === null)
      .slice(0, 30)
      .map((image) => {
        const suggestion = image.context ?? altFromFilename(image.src);
        return {
          target: "image-alt" as const,
          description: `Add alt text to ${image.src}`,
          before: `<img src="${escapeHtml(image.src)}">`,
          after: `<img src="${escapeHtml(image.src)}" alt="${escapeHtml(suggestion)}">`,
          notes: suggestion
            ? ["Suggested from the file name or caption. Check that it describes the image; Claude can look at the image to improve it."]
            : ['No usable hint in the file name. Describe the image, or use alt="" if it is purely decorative.'],
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
        before: `href="${item.url}"`,
        after: replacement ? `href="${replacement}"` : "Remove the link (keep the text) or point it to the most relevant live page",
        notes: replacement
          ? ["Closest matching live URL by path. Confirm it is the right destination."]
          : ["No close match found among known pages."],
      };
    });
  },

  async "open-graph"(page) {
    const brand = primaryBrand(page);
    const image = page.og["og:image"] ?? page.images.find((img) => /\.(jpe?g|png|webp)(\?|$)/i.test(img.src))?.src;
    const tags = [
      `<meta property="og:title" content="${escapeHtml(page.title ?? suggestTitle(page))}">`,
      `<meta property="og:description" content="${escapeHtml(page.metaDescription ?? suggestMetaDescription(page))}">`,
      `<meta property="og:url" content="${escapeHtml(page.canonicals[0] ?? page.url)}">`,
      `<meta property="og:type" content="${page.schemaTypes.some((type) => /Article|BlogPosting/.test(type)) ? "article" : "website"}">`,
      ...(brand ? [`<meta property="og:site_name" content="${escapeHtml(brand)}">`] : []),
      ...(image ? [`<meta property="og:image" content="${escapeHtml(image)}">`] : []),
    ];
    return [
      {
        target: "head",
        description: "Add Open Graph tags",
        after: tags.join("\n"),
        notes: image ? ["Ideal share image size is 1200x630."] : ["No suitable image found; add og:image with a 1200x630 image."],
      },
    ];
  },

  async "robots-sitemap-line"(page, ctx) {
    const origin = new URL(page.url).origin;
    const [robots, sitemap] = await Promise.all([ctx.fetch(`${origin}/robots.txt`, { accept: "text/plain" }), ctx.sitemap(origin)]);
    const sitemapUrl = sitemap.sources[0] ?? `${origin}/sitemap.xml`;
    const before = robots.ok ? robots.body.trimEnd() : "";
    return [
      {
        target: "robots.txt",
        description: "Reference the sitemap in robots.txt",
        ...(before ? { before } : {}),
        after: `${before}${before ? "\n\n" : ""}Sitemap: ${sitemapUrl}`,
        notes: ["Only a Sitemap line is added; existing rules are unchanged."],
      },
    ];
  },

  async "html-lang"(page) {
    const fromHeader = page.headers["content-language"]?.split(",")[0]?.trim();
    const fromOg = page.og["og:locale"]?.replace("_", "-");
    const lang = fromHeader || fromOg?.split("-")[0] || "en";
    return [
      {
        target: "html-tag",
        description: "Declare the page language",
        before: "<html>",
        after: `<html lang="${escapeHtml(lang)}">`,
        notes: fromHeader || fromOg ? [`Detected from ${fromHeader ? "the Content-Language header" : "og:locale"}.`] : ["Assumed English; change if the site is in another language."],
      },
    ];
  },

  async "faq-schema"(page) {
    const pairs = page.questions.filter((question) => question.answerWords >= 5).slice(0, 20);
    if (pairs.length < 2) return [];
    const data = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: pairs.map((pair) => ({
        "@type": "Question",
        name: pair.question,
        acceptedAnswer: { "@type": "Answer", text: pair.answer },
      })),
    };
    return [
      {
        target: "json-ld",
        description: `Add FAQPage markup for ${pairs.length} visible questions`,
        after: jsonLdScript(data),
        notes: [
          "Copied word-for-word from the visible FAQ; keep them in sync when the FAQ changes.",
          "Google shows FAQ rich results only for some sites, but the markup still helps search and AI systems read the Q&A.",
        ],
      },
    ];
  },

  async "llms-txt"(page, ctx) {
    const origin = new URL(page.url).origin;
    const brand = primaryBrand(page) ?? new URL(page.url).hostname;
    const summary = page.metaDescription ?? suggestMetaDescription(page);
    const navLinks = page.links.filter((link) => link.internal && link.inHeader && link.text && link.text.length <= 60);
    const unique = new Map<string, string>();
    for (const link of navLinks) if (!unique.has(comparableUrl(link.href))) unique.set(comparableUrl(link.href), `- [${link.text}](${link.href})`);
    if (unique.size < 3) {
      const sitemap = await ctx.sitemap(origin);
      for (const entry of sitemap.entries.filter((e) => URL.canParse(e.loc)).slice(0, 15)) {
        const slug = new URL(entry.loc).pathname.split("/").filter(Boolean).pop()?.replace(/[-_]/g, " ") ?? "Home";
        if (!unique.has(comparableUrl(entry.loc))) unique.set(comparableUrl(entry.loc), `- [${slug}](${entry.loc})`);
      }
    }
    const contact = [
      ...page.telLinks.slice(0, 1).map((phone) => `- Phone: ${phone}`),
      ...page.mailtoLinks.slice(0, 1).map((email) => `- Email: ${email}`),
    ];
    const content = [
      `# ${brand}`,
      "",
      `> ${summary}`,
      "",
      "## Key pages",
      ...[...unique.values()].slice(0, 15),
      ...(contact.length ? ["", "## Contact", ...contact] : []),
      "",
    ].join("\n");
    return [
      {
        target: "llms.txt",
        description: `Publish ${origin}/llms.txt`,
        after: content,
        notes: ["Draft built from your navigation. Edit the summary so it states exactly what you do, for whom and where."],
      },
    ];
  },

  async "same-as"(page) {
    if (!page.socialLinks.length) return [];
    const organization = page.jsonLd
      .flatMap((block) => (block.data ? topLevelNodes(block.data) : []))
      .find((node) => {
        const type = node["@type"];
        const types = Array.isArray(type) ? type : [type];
        return types.some((t) => typeof t === "string" && /Organization|LocalBusiness|Corporation/.test(t));
      });
    const sameAs = page.socialLinks.slice(0, 15);
    return [
      {
        target: "json-ld",
        description: "Link official profiles with sameAs",
        after: organization ? jsonLdScript({ ...organization, sameAs }) : `"sameAs": ${JSON.stringify(sameAs, null, 2)}`,
        notes: [
          organization ? "Replaces the existing Organization block with the same data plus sameAs." : "Add this property to your Organization markup.",
          "Only include profiles the business officially owns.",
        ],
      },
    ];
  },

  async "tel-link"(page) {
    return page.phonesInText.slice(0, 5).map((phone) => {
      const digits = phone.replace(/[^\d+]/g, "");
      return {
        target: "body-element" as const,
        description: `Make ${phone} tap-to-call`,
        before: phone,
        after: `<a href="tel:${digits}">${escapeHtml(phone)}</a>`,
        notes: digits.startsWith("+") ? [] : ["Add the country code to the tel: link (for example tel:+1...) for international callers."],
      };
    });
  },

  async "schema-context"(page) {
    return page.jsonLd
      .filter((block) => block.data && !Array.isArray(block.data) && !("@context" in (block.data as object)))
      .map((block) => ({
        target: "json-ld" as const,
        description: "Add @context to JSON-LD",
        before: block.raw.slice(0, 300),
        after: jsonLdScript({ "@context": "https://schema.org", ...(block.data as object) }),
      }));
  },

  async "website-schema"(page) {
    const brand = primaryBrand(page);
    const origin = `${new URL(page.url).origin}/`;
    return [
      {
        target: "json-ld",
        description: "Add WebSite markup to the homepage",
        after: jsonLdScript({ "@context": "https://schema.org", "@type": "WebSite", name: brand ?? new URL(page.url).hostname, url: origin }),
        notes: brand ? [] : ["No brand name found; replace the hostname with your official site name."],
      },
    ];
  },

  async "breadcrumb-schema"(page) {
    if (page.breadcrumb.length < 2) return [];
    const data = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: page.breadcrumb.map((item, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: item.name,
        item: item.href ?? (index === page.breadcrumb.length - 1 ? page.url : undefined),
      })),
    };
    return [{ target: "json-ld", description: "Add BreadcrumbList markup", after: jsonLdScript(data), notes: ["Mirrors the visible breadcrumb."] }];
  },
};

export function fixGenerator(kind: FixKind): FixGenerator {
  return GENERATORS[kind];
}
