import type { PageData } from "@/core/extract";
import {
  cannibalization,
  homepageOnly,
  lowCtr,
  questionQueries,
  strikingDistance,
  type SearchRow,
} from "@/core/search-data";
import { isOkHtml, keywordCoverage, loadPages, loadTarget, pickSamplePages } from "./shared";
import { emptyOutput, type AuditModule } from "./types";

export interface ContentOpportunityInput {
  url: string;
  /** Pages to sample for depth checks (1-25). */
  maxPages?: number;
  /** Services, products or topics that matter most to the business. */
  priorityTopics?: string[];
  /** Query+page rows from Search Console, supplied by the tool layer when connected. */
  searchRows?: SearchRow[];
}

type PageKind = "about" | "contact" | "faq" | "blog" | "services" | "proof" | "pricing" | "locations";

const PAGE_PATTERNS: Record<PageKind, RegExp> = {
  about: /\/(about|about-us|company|who-we-are|our-story|team)(\/|$)/i,
  contact: /\/(contact|contact-us|get-in-touch)(\/|$)/i,
  faq: /\/(faqs?|frequently-asked-questions|help|support)(\/|$)/i,
  blog: /\/(blog|news|insights|articles|resources|guides|learn)(\/|$)/i,
  services: /\/(services?|solutions|what-we-do|treatments|practice-areas|products?|shop|collections)(\/|$)/i,
  proof: /\/(case-stud(y|ies)|portfolio|our-work|work|projects|testimonials|reviews|success-stories|results)(\/|$)/i,
  pricing: /\/(pricing|prices|plans|packages|rates|cost)(\/|$)/i,
  locations: /\/(locations?|areas?-we-serve|service-areas?|cities)(\/|$)/i,
};

const KEY_PAGE_LABEL: Partial<Record<PageKind, string>> = {
  about: "About page",
  contact: "Contact page",
  faq: "FAQ page or section",
  services: "Dedicated service or product pages",
  proof: "Case studies, portfolio or testimonials page",
  blog: "Blog or resource section",
};

function classifyUrls(urls: string[]): Record<PageKind, string[]> {
  const result = Object.fromEntries(Object.keys(PAGE_PATTERNS).map((kind) => [kind, [] as string[]])) as Record<PageKind, string[]>;
  for (const url of urls) {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      continue;
    }
    for (const [kind, pattern] of Object.entries(PAGE_PATTERNS) as [PageKind, RegExp][]) {
      if (pattern.test(path) || pattern.test(`${path}/`)) result[kind].push(url);
    }
  }
  return result;
}

export const contentOpportunityAudit: AuditModule<ContentOpportunityInput> = {
  id: "content",
  name: "Content Opportunity Check",
  async run(ctx, input) {
    const output = emptyOutput();
    const { page: home } = await loadTarget(ctx, input.url);
    const origin = new URL(home.url).origin;
    const add = (code: string, detail?: string, evidence?: Record<string, unknown>, target = home.url) =>
      output.findings.push({ code, url: target, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) });

    const sitemap = await ctx.sitemap(origin);
    const knownUrls = [
      ...new Set([...home.links.filter((link) => link.internal).map((link) => link.href.split("#")[0] ?? link.href), ...sitemap.entries.map((e) => e.loc)]),
    ].filter((url) => URL.canParse(url));
    const kinds = classifyUrls(knownUrls);
    const homeHasFaq = home.questions.length >= 3;

    // Collected into one finding so the list reads as a single opportunity.
    const missingPages: string[] = [];
    for (const [kind, label] of Object.entries(KEY_PAGE_LABEL) as [PageKind, string][]) {
      if (kinds[kind].length) continue;
      if (kind === "faq" && homeHasFaq) continue;
      if (kind === "services" && knownUrls.length > 15) continue; // Larger sites often use custom slugs for services.
      missingPages.push(`No ${label} found`);
    }

    // Depth check: service and location pages matter most for revenue.
    const maxPages = Math.min(Math.max(input.maxPages ?? 8, 1), 25);
    const priorityUrls = [...kinds.services, ...kinds.locations].slice(0, maxPages);
    const sampleUrls = priorityUrls.length ? priorityUrls : await pickSamplePages(ctx, home, maxPages);
    const pages = (await loadPages(ctx, sampleUrls)).filter(isOkHtml);
    const thin = pages.filter((page) => page.wordCount < 300 && !PAGE_PATTERNS.contact.test(new URL(page.url).pathname));
    if (thin.length) {
      add("content.pages.thin", `${thin.length} of ${pages.length} sampled pages have under 300 words`, {
        pages: thin.map((page) => ({ url: page.url, words: page.wordCount })),
      });
    }

    const blogDates = sitemap.entries
      .filter((entry) => URL.canParse(entry.loc) && PAGE_PATTERNS.blog.test(new URL(entry.loc).pathname) && entry.lastmod)
      .map((entry) => Date.parse(entry.lastmod!))
      .filter((time) => !Number.isNaN(time));
    if (blogDates.length) {
      const days = Math.round((Date.now() - Math.max(...blogDates)) / 86_400_000);
      if (days > 180) add("content.blog.stale", `Most recent blog update was ${days} days ago`);
      else output.passed.push(`Blog updated ${days} days ago`);
    }

    // Priority topics the business cares about.
    const topics = (input.priorityTopics ?? []).map((topic) => topic.trim()).filter(Boolean).slice(0, 15);
    if (topics.length) {
      const corpus: { url: string; text: string }[] = [
        ...knownUrls.map((url) => ({ url, text: decodeURIComponent(new URL(url).pathname).replace(/[-_/]/g, " ") })),
        ...[home, ...pages].map((page: PageData) => ({ url: page.url, text: `${page.title ?? ""} ${page.h1s.join(" ")}` })),
      ];
      const uncovered = topics.filter((topic) => !corpus.some((item) => keywordCoverage(topic, item.text) >= 0.75));
      for (const topic of uncovered) missingPages.push(`No dedicated page found for "${topic}"`);
      if (uncovered.length < topics.length) output.passed.push(`${topics.length - uncovered.length} of ${topics.length} priority topics have a dedicated page`);
    } else {
      output.askUser.push("Which services, products or locations bring in the most revenue? Pages for those are checked first.");
    }

    if (missingPages.length) add("content.key_page.missing", missingPages.join("; "), { missing: missingPages });

    // Search Console opportunities (only when connected).
    const rows = input.searchRows ?? [];
    if (rows.length) {
      const striking = strikingDistance(rows);
      if (striking.length) add("content.gsc.striking_distance", `${striking.length} queries in positions 8-20`, { queries: striking });
      const ctr = lowCtr(rows);
      if (ctr.length) add("content.gsc.low_ctr", `${ctr.length} queries with CTR well below normal for their position`, { queries: ctr });
      const questions = questionQueries(rows);
      if (questions.length) add("content.gsc.question_queries", `${questions.length} question searches`, { queries: questions });
      const competing = cannibalization(rows);
      if (competing.length) add("content.gsc.cannibalization", `${competing.length} queries split across several pages`, { queries: competing });
      const homeOnly = homepageOnly(rows, home.url);
      if (homeOnly.length) add("content.gsc.homepage_only", `${homeOnly.length} specific queries land only on the homepage`, { queries: homeOnly });
      output.facts.searchRowsAnalyzed = rows.length;
    } else {
      output.notes.push("Search Console is not connected, so opportunities are based on site structure only.");
    }

    output.facts = {
      ...output.facts,
      pagesKnown: knownUrls.length,
      sitemapFound: sitemap.found,
      pageTypes: Object.fromEntries(Object.entries(kinds).map(([kind, urls]) => [kind, urls.length])),
      sampled: pages.map((page) => ({ url: page.url, words: page.wordCount })),
    };
    return output;
  },
};
