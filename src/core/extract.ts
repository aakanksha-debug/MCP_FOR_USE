import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { FetchResult } from "./http";

/**
 * Parses a fetched HTML page once into plain data that every audit reads.
 * Audits never touch cheerio directly, which keeps them small and testable.
 */

export interface LinkInfo {
  href: string;
  text: string;
  rel: string;
  internal: boolean;
  inHeader: boolean;
  inFooter: boolean;
  /** 0-1 position of the element in document order. */
  position: number;
}

export interface ImageInfo {
  src: string;
  alt: string | null;
  hasDimensions: boolean;
  loading?: string;
  context?: string;
}

export interface JsonLdBlock {
  raw: string;
  data?: unknown;
  error?: string;
}

export interface QuestionBlock {
  question: string;
  answer: string;
  answerWords: number;
  /** First block after the question (what an answer engine would quote). */
  firstAnswerWords: number;
}

export interface FormInfo {
  action: string;
  fieldCount: number;
  fieldTypes: string[];
}

export interface CtaInfo {
  text: string;
  href?: string;
  position: number;
  inHeader: boolean;
}

export interface PageData {
  requestedUrl: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  redirects: { url: string; status: number }[];
  timingMs: number;
  bytes: number;
  truncated: boolean;
  isHtml: boolean;
  error?: string;

  lang?: string;
  titles: string[];
  title?: string;
  metaDescriptions: string[];
  metaDescription?: string;
  canonicals: string[];
  robotsMeta?: string;
  xRobotsTag?: string;
  viewport?: string;
  og: Record<string, string>;
  siteName?: string;
  hreflang: { lang: string; href: string }[];

  headings: { level: number; text: string }[];
  h1s: string[];
  links: LinkInfo[];
  images: ImageInfo[];
  iframes: string[];
  jsonLd: JsonLdBlock[];
  schemaTypes: string[];
  microdataTypes: string[];

  text: string;
  wordCount: number;
  bodyWordCount: number;
  firstParagraph?: string;
  paragraphs: string[];
  listCount: number;
  tableCount: number;
  questions: QuestionBlock[];
  breadcrumb: { name: string; href?: string }[];

  forms: FormInfo[];
  telLinks: string[];
  mailtoLinks: string[];
  phonesInText: string[];
  hasAddress: boolean;
  ctas: CtaInfo[];
  socialLinks: string[];
  mapEmbeds: string[];
  profileLinks: string[];
  author?: string;
  datePublished?: string;
  dateModified?: string;
  scriptCount: number;
  mixedContent: string[];
  hasTrustSignals: boolean;
  numberMentions: number;
  externalCitationLinks: number;
}

const QUESTION_START =
  /^(what|why|how|when|where|who|whom|which|can|could|do|does|did|is|are|was|were|should|will|would|may|has|have)\b/i;

const CTA_PATTERN =
  /\b(contact|call|get (?:a |your |an )?(?:free )?(?:quote|estimate|consultation|started|demo|proposal|audit|offer)|book|schedule|request|buy|shop|order|sign ?up|start (?:now|today|free)|talk to|speak (?:to|with)|enquire|inquire|hire|apply|subscribe|try (?:it )?free|free (?:consultation|quote|trial|estimate|audit)|let'?s talk|reserve|donate|join)\b/i;

const SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "threads.net",
  "yelp.com",
  "clutch.co",
  "crunchbase.com",
  "wikipedia.org",
  "github.com",
  "trustpilot.com",
  "bbb.org",
  "tripadvisor.com",
];

const TRUST_PATTERN =
  /\b(testimonials?|reviews?|rated|5[- ]stars?|case stud(?:y|ies)|our clients|trusted by|award|certified|accredited|guarantee|licensed|insured|years of experience|clients served|success stor(?:y|ies))\b/i;

const ADDRESS_PATTERN =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s){1,5}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|suite|ste|way|court|ct|place|pl|parkway|pkwy|highway|hwy|square|sq)\b\.?/i;

const PHONE_PATTERN = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,5}\b/g;

function clean(text: string | undefined | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function words(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function resolveUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  const value = href.trim();
  if (!value || value.startsWith("#") || /^(javascript|data):/i.test(value)) return undefined;
  try {
    return new URL(value, base).toString();
  } catch {
    return undefined;
  }
}

function sameSite(a: string, b: string): boolean {
  try {
    const hostA = new URL(a).hostname.replace(/^www\./, "");
    const hostB = new URL(b).hostname.replace(/^www\./, "");
    return hostA === hostB;
  } catch {
    return false;
  }
}

/** Collects every @type found in JSON-LD, including nested objects and @graph. */
export function collectSchemaTypes(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaTypes(item, into);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const type = record["@type"];
    if (typeof type === "string") into.add(type);
    if (Array.isArray(type)) for (const t of type) if (typeof t === "string") into.add(t);
    for (const [key, child] of Object.entries(record)) {
      if (key !== "@type" && child && typeof child === "object") collectSchemaTypes(child, into);
    }
  }
  return into;
}

/** Finds the first JSON-LD node with a given string property, depth-first. */
function findJsonLdValue(blocks: JsonLdBlock[], keys: string[]): string | undefined {
  const visit = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          const name = (candidate as Record<string, unknown>).name;
          if (typeof name === "string" && name.trim()) return name.trim();
        }
        if (Array.isArray(candidate)) {
          const first = candidate[0] as Record<string, unknown> | string | undefined;
          if (typeof first === "string") return first;
          if (first && typeof first.name === "string") return first.name;
        }
      }
      for (const child of Object.values(record)) {
        if (child && typeof child === "object") {
          const found = visit(child);
          if (found) return found;
        }
      }
    }
    return undefined;
  };
  for (const block of blocks) {
    const found = visit(block.data);
    if (found) return found;
  }
  return undefined;
}

function textWithoutChrome($: CheerioAPI, root: cheerio.Cheerio<AnyNode>): string {
  const clone = root.clone();
  clone.find("script, style, noscript, template, svg, iframe, canvas").remove();
  return clean(clone.text());
}

function mainContent($: CheerioAPI): cheerio.Cheerio<AnyNode> {
  for (const selector of ["main", "[role=main]", "article"]) {
    const candidate = $(selector).first();
    if (candidate.length && words(textWithoutChrome($, candidate)) > 50) return candidate;
  }
  const body = $("body").clone();
  body.find("header, nav, footer, [role=navigation], [role=banner], [role=contentinfo]").remove();
  return body;
}

function extractQuestions($: CheerioAPI): QuestionBlock[] {
  const questions: QuestionBlock[] = [];
  const seen = new Set<string>();
  const add = (question: string, blocks: string[]) => {
    const q = clean(question);
    if (!q || seen.has(q.toLowerCase())) return;
    seen.add(q.toLowerCase());
    const answer = clean(blocks.join(" "));
    questions.push({
      question: q,
      answer: answer.slice(0, 1200),
      answerWords: words(answer),
      firstAnswerWords: words(clean(blocks[0] ?? "")),
    });
  };

  $("h2, h3, h4, h5, summary, dt, [itemprop=name]").each((_, el) => {
    const element = $(el);
    const text = clean(element.text());
    if (text.length < 8 || text.length > 160) return;
    if (!text.endsWith("?") && !QUESTION_START.test(text)) return;

    const blocks: string[] = [];
    if (el.tagName === "summary") {
      const details = element.parent();
      const clone = details.clone();
      clone.find("summary").remove();
      blocks.push(textWithoutChrome($, clone));
    } else if (el.tagName === "dt") {
      blocks.push(clean(element.nextAll("dd").first().text()));
    } else if (element.attr("itemprop") === "name") {
      blocks.push(clean(element.closest("[itemtype*=Question]").find("[itemprop=text]").first().text()));
    } else {
      let siblings = element.nextUntil("h1, h2, h3, h4, h5, h6");
      if (!siblings.length) siblings = element.parent().nextUntil(":has(h1, h2, h3, h4, h5, h6)").slice(0, 3);
      siblings.slice(0, 6).each((__, sibling) => {
        const value = textWithoutChrome($, $(sibling));
        if (value) blocks.push(value);
      });
    }
    add(text, blocks.filter(Boolean));
  });
  return questions.slice(0, 40);
}

function extractBreadcrumb($: CheerioAPI, base: string): { name: string; href?: string }[] {
  const container = $(
    "nav[aria-label*=readcrumb], [class*=breadcrumb], [id*=breadcrumb], ol[itemtype*=BreadcrumbList]",
  ).first();
  if (!container.length) return [];
  const items: { name: string; href?: string }[] = [];
  container.find("a, li > span:not(:has(a)), [aria-current]").each((_, el) => {
    const name = clean($(el).text());
    if (!name || name.length > 80 || /^[>/»›|]+$/.test(name)) return;
    const href = el.tagName === "a" ? resolveUrl($(el).attr("href"), base) : undefined;
    if (!items.some((item) => item.name === name)) items.push(href ? { name, href } : { name });
  });
  return items.length >= 2 ? items : [];
}

export function emptyPage(result: FetchResult): PageData {
  return {
    requestedUrl: result.requestedUrl,
    url: result.url,
    status: result.status,
    headers: result.headers,
    redirects: result.redirects,
    timingMs: result.timingMs,
    bytes: result.bytes,
    truncated: result.truncated,
    isHtml: false,
    ...(result.error ? { error: result.error } : {}),
    titles: [],
    metaDescriptions: [],
    canonicals: [],
    og: {},
    hreflang: [],
    headings: [],
    h1s: [],
    links: [],
    images: [],
    iframes: [],
    jsonLd: [],
    schemaTypes: [],
    microdataTypes: [],
    text: "",
    wordCount: 0,
    bodyWordCount: 0,
    paragraphs: [],
    listCount: 0,
    tableCount: 0,
    questions: [],
    breadcrumb: [],
    forms: [],
    telLinks: [],
    mailtoLinks: [],
    phonesInText: [],
    hasAddress: false,
    ctas: [],
    socialLinks: [],
    mapEmbeds: [],
    profileLinks: [],
    scriptCount: 0,
    mixedContent: [],
    hasTrustSignals: false,
    numberMentions: 0,
    externalCitationLinks: 0,
  };
}

export function extractPage(result: FetchResult): PageData {
  const contentType = result.headers["content-type"] ?? "";
  const looksHtml = /html|xml/i.test(contentType) || /<html|<!doctype html/i.test(result.body.slice(0, 2000));
  if (!result.body || !looksHtml) return emptyPage(result);

  const $ = cheerio.load(result.body);
  const base = resolveUrl($("base[href]").attr("href"), result.url) ?? result.url;
  const page = emptyPage(result);
  page.isHtml = true;

  // Document order index for position-based heuristics.
  const order = new Map<Element, number>();
  const allElements = $("body *").toArray() as Element[];
  allElements.forEach((el, index) => order.set(el, index));
  const position = (el: Element) => (allElements.length ? (order.get(el) ?? 0) / allElements.length : 0);
  const inChrome = (el: Element, selector: string) => $(el).closest(selector).length > 0;

  page.lang = $("html").attr("lang")?.trim() || undefined;
  page.titles = $("title")
    .toArray()
    .filter((el) => $(el).closest("svg").length === 0)
    .map((el) => clean($(el).text()))
    .filter(Boolean);
  page.title = page.titles[0];
  page.metaDescriptions = $("meta[name=description i]")
    .toArray()
    .map((el) => clean($(el).attr("content")))
    .filter(Boolean);
  page.metaDescription = page.metaDescriptions[0];
  page.canonicals = $("link[rel=canonical i]")
    .toArray()
    .map((el) => resolveUrl($(el).attr("href"), base))
    .filter((href): href is string => Boolean(href));
  page.robotsMeta = clean($("meta[name=robots i], meta[name=googlebot i]").attr("content")) || undefined;
  page.xRobotsTag = result.headers["x-robots-tag"];
  page.viewport = $("meta[name=viewport i]").attr("content") || undefined;
  $("meta[property^='og:']").each((_, el) => {
    const property = $(el).attr("property");
    const content = clean($(el).attr("content"));
    if (property && content) page.og[property] = content;
  });
  page.siteName = page.og["og:site_name"];
  page.hreflang = $("link[rel=alternate][hreflang]")
    .toArray()
    .map((el) => ({ lang: $(el).attr("hreflang") ?? "", href: resolveUrl($(el).attr("href"), base) ?? "" }));

  page.headings = $("h1, h2, h3, h4, h5, h6")
    .toArray()
    .map((el) => ({ level: Number(el.tagName.slice(1)), text: clean($(el).text()) }))
    .filter((heading) => heading.text);
  page.h1s = page.headings.filter((heading) => heading.level === 1).map((heading) => heading.text);

  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href") ?? "";
    if (/^tel:/i.test(raw)) page.telLinks.push(raw.replace(/^tel:/i, "").trim());
    if (/^mailto:/i.test(raw)) page.mailtoLinks.push(raw.replace(/^mailto:/i, "").split("?")[0]?.trim() ?? "");
    const href = resolveUrl(raw, base);
    if (!href || !/^https?:/i.test(href)) return;
    const text = clean($(el).text()) || clean($(el).attr("aria-label")) || clean($(el).find("img").attr("alt"));
    page.links.push({
      href,
      text,
      rel: ($(el).attr("rel") ?? "").toLowerCase(),
      internal: sameSite(href, result.url),
      inHeader: inChrome(el, "header, nav, [role=banner], [role=navigation]"),
      inFooter: inChrome(el, "footer, [role=contentinfo]"),
      position: position(el),
    });
  });

  page.images = $("img")
    .toArray()
    .map((el) => {
      const img = $(el);
      const src =
        resolveUrl(img.attr("src") ?? img.attr("data-src") ?? img.attr("data-lazy-src"), base) ??
        img.attr("src") ??
        "";
      const alt = img.attr("alt");
      const caption = clean(img.closest("figure").find("figcaption").text()) || clean(img.attr("title"));
      return {
        src,
        alt: alt === undefined ? null : alt,
        hasDimensions: Boolean(img.attr("width") && img.attr("height")),
        ...(img.attr("loading") ? { loading: img.attr("loading") } : {}),
        ...(caption ? { context: caption } : {}),
      };
    })
    .filter((image) => image.src && !image.src.startsWith("data:"));

  page.iframes = $("iframe[src]")
    .toArray()
    .map((el) => resolveUrl($(el).attr("src"), base))
    .filter((src): src is string => Boolean(src));

  $("script[type='application/ld+json' i]").each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      page.jsonLd.push({ raw, data: JSON.parse(raw) });
    } catch (error) {
      page.jsonLd.push({ raw: raw.slice(0, 500), error: (error as Error).message });
    }
  });
  const types = new Set<string>();
  for (const block of page.jsonLd) if (block.data) collectSchemaTypes(block.data, types);
  page.microdataTypes = $("[itemtype]")
    .toArray()
    .map((el) => ($(el).attr("itemtype") ?? "").split("/").pop() ?? "")
    .filter(Boolean);
  for (const type of page.microdataTypes) types.add(type);
  page.schemaTypes = [...types];

  const main = mainContent($);
  page.text = textWithoutChrome($, main).slice(0, 60_000);
  page.wordCount = words(page.text);
  page.bodyWordCount = words(textWithoutChrome($, $("body")));
  page.paragraphs = main
    .find("p")
    .toArray()
    .map((el) => clean($(el).text()))
    .filter((text) => words(text) >= 5);
  page.firstParagraph = page.paragraphs[0];
  page.listCount = main.find("ul, ol").filter((_, el) => $(el).find("li").length >= 2).length;
  page.tableCount = main.find("table").length;
  page.questions = extractQuestions($);
  page.breadcrumb = extractBreadcrumb($, base);

  page.forms = $("form")
    .toArray()
    .map((el) => {
      const fields = $(el)
        .find("input, select, textarea")
        .toArray()
        .filter((field) => !/^(hidden|submit|button|reset|image)$/i.test($(field).attr("type") ?? ""));
      return {
        action: $(el).attr("action") ?? "",
        fieldCount: fields.length,
        fieldTypes: fields.map((field) => $(field).attr("type") ?? field.tagName),
      };
    })
    .filter((form) => form.fieldCount > 0 && !/search/i.test(form.action) && !(form.fieldCount === 1 && form.fieldTypes[0] === "search"));

  const bodyText = textWithoutChrome($, $("body"));
  page.phonesInText = [
    ...new Set(
      (bodyText.match(PHONE_PATTERN) ?? [])
        .map((phone) => phone.trim())
        .filter((phone) => {
          const digits = phone.replace(/\D/g, "");
          return digits.length >= 10 && digits.length <= 13 && !/^(19|20)\d{2}[\s.-]/.test(phone);
        }),
    ),
  ].slice(0, 10);
  page.hasAddress =
    $("address").length > 0 ||
    page.schemaTypes.includes("PostalAddress") ||
    ADDRESS_PATTERN.test(bodyText);

  $("a, button, input[type=submit]").each((_, el) => {
    const node = $(el);
    const text = clean(node.text()) || clean(node.attr("value")) || clean(node.attr("aria-label"));
    if (!text || text.length > 60 || !CTA_PATTERN.test(text)) return;
    const href = el.tagName === "a" ? resolveUrl(node.attr("href"), base) ?? node.attr("href") : undefined;
    page.ctas.push({
      text,
      ...(href ? { href } : {}),
      position: position(el),
      inHeader: inChrome(el, "header, nav, [role=banner]"),
    });
  });

  page.socialLinks = [
    ...new Set(
      page.links
        .filter((link) => !link.internal)
        .map((link) => link.href)
        .filter((href) => {
          try {
            const host = new URL(href).hostname.replace(/^www\./, "");
            return SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`));
          } catch {
            return false;
          }
        }),
    ),
  ];
  page.mapEmbeds = page.iframes.filter((src) => /google\.[a-z.]+\/maps|maps\.google\./i.test(src));
  page.profileLinks = page.links
    .map((link) => link.href)
    .filter((href) =>
      /(g\.page\/|maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps|maps\.google\.|search\.google\.com\/local|business\.google\.com)/i.test(
        href,
      ),
    );

  page.author =
    findJsonLdValue(page.jsonLd, ["author", "creator"]) ||
    clean($("meta[name=author i]").attr("content")) ||
    clean($("[rel=author]").first().text()) ||
    clean($("[class*=author] [class*=name], .byline, [itemprop=author]").first().text()) ||
    undefined;
  page.datePublished =
    findJsonLdValue(page.jsonLd, ["datePublished"]) ||
    $("meta[property='article:published_time']").attr("content") ||
    $("time[datetime]").first().attr("datetime") ||
    undefined;
  page.dateModified =
    findJsonLdValue(page.jsonLd, ["dateModified"]) ||
    $("meta[property='article:modified_time']").attr("content") ||
    undefined;

  page.scriptCount = $("script").length;
  if (result.url.startsWith("https:")) {
    page.mixedContent = $("img[src], script[src], link[rel=stylesheet][href], iframe[src], source[src], video[src], audio[src]")
      .toArray()
      .map((el) => $(el).attr("src") ?? $(el).attr("href") ?? "")
      .filter((src) => /^http:\/\//i.test(src))
      .slice(0, 20);
  }
  page.hasTrustSignals =
    TRUST_PATTERN.test(bodyText) ||
    page.schemaTypes.some((type) => type === "AggregateRating" || type === "Review");
  page.numberMentions = (page.text.match(/\b\d+(?:[.,]\d+)?\s?(?:%|percent|years?|clients?|customers?|projects?|x\b)/gi) ?? [])
    .length;
  page.externalCitationLinks = main
    .find("a[href^='http']")
    .toArray()
    .filter((el) => !sameSite($(el).attr("href") ?? "", result.url))
    .filter((el) => {
      const href = $(el).attr("href") ?? "";
      return !SOCIAL_HOSTS.some((social) => href.includes(social));
    }).length;

  return page;
}
