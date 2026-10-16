import { describe, expect, it } from "vitest";
import {
  aeoAudit,
  contentOpportunityAudit,
  conversionAudit,
  gbpAudit,
  geoAudit,
  runFullAudit,
  schemaAudit,
  seoHealthAudit,
  technicalAudit,
} from "@/audits";
import { runAudit } from "@/audits/types";
import { createAuditContext } from "@/core/context";
import type { AuditResult } from "@/core/types";
import { ORIGIN, siteFetcher } from "./fixtures/site";

const ctx = () => createAuditContext({ fetcher: siteFetcher() });
const codes = (result: AuditResult) => new Set(result.issues.map((issue) => issue.code));
const HOME = `${ORIGIN}/`;

describe("SEO health", () => {
  it("finds the planted on-page problems", async () => {
    const result = await runAudit(seoHealthAudit, ctx(), { url: "www.acmeplumbing.test", maxPages: 5 });
    const found = codes(result);
    expect(found).toContain("seo.title.too_long");
    expect(found).toContain("seo.meta_description.missing");
    expect(found).toContain("seo.images.missing_alt");
    expect(found).toContain("seo.links.broken_internal");
    expect(found).toContain("seo.content.thin");
    expect(found).toContain("technical.canonical.points_elsewhere");
    const broken = result.issues.find((issue) => issue.code === "seo.links.broken_internal");
    expect(broken?.url).toBe(HOME);
    expect(broken?.detail).toContain("/broken-page/");
    expect(result.score).toBeLessThan(100);
  });
});

describe("Technical", () => {
  it("checks crawl directives, redirects and headers", async () => {
    const result = await runAudit(technicalAudit, ctx(), { url: HOME });
    const found = codes(result);
    expect(found).toContain("technical.lang.missing");
    expect(found).toContain("technical.canonical.missing");
    expect(found).toContain("technical.sitemap.not_in_robots");
    expect(found).toContain("technical.mixed_content");
    expect(found).toContain("technical.hsts.missing");
    expect(found).not.toContain("technical.https.no_redirect");
    expect(found).not.toContain("technical.www.duplicate");
    expect(found).not.toContain("technical.robots_txt.blocks_all");
    expect(result.passed.join(" ")).toContain("redirects to the main hostname");
  });
});

describe("GEO", () => {
  it("separates AI search crawlers from training crawlers", async () => {
    const result = await runAudit(geoAudit, ctx(), { url: HOME });
    const blocked = result.issues.find((issue) => issue.code === "geo.ai_crawlers.blocked");
    expect(blocked?.tier).toBe("high");
    expect(blocked?.detail).toContain("PerplexityBot");
    expect(blocked?.detail).not.toContain("GPTBot");
    expect(result.notes.join(" ")).toContain("GPTBot");
    expect(codes(result)).toContain("geo.llms_txt.missing");
    expect(codes(result)).toContain("geo.entity.same_as_missing");
    expect(codes(result)).not.toContain("geo.entity.about_page_missing");
  });
});

describe("AEO", () => {
  it("detects question blocks and checks coverage of customer questions", async () => {
    const result = await runAudit(aeoAudit, ctx(), {
      url: HOME,
      questions: ["Do you offer emergency plumbing?", "How much does a tankless water heater installation cost?"],
    });
    expect(codes(result)).toContain("aeo.faq_schema.missing");
    const uncovered = result.issues.find((issue) => issue.code === "aeo.questions.uncovered");
    expect(uncovered?.evidence?.questions).toEqual(["How much does a tankless water heater installation cost?"]);
    expect(result.passed.join(" ")).toContain("3 question-style headings");
  });
});

describe("Conversion", () => {
  it("flags the generic headline, plain-text phone and long form", async () => {
    const result = await runAudit(conversionAudit, ctx(), { url: HOME });
    const found = codes(result);
    expect(found).toContain("conversion.value_prop.unclear");
    expect(found).toContain("conversion.phone.not_clickable");
    expect(found).toContain("conversion.form.too_many_fields");
    expect(found).not.toContain("conversion.contact.no_form_or_email");
    expect(found).not.toContain("conversion.cta.missing");
    expect(found).not.toContain("conversion.trust.missing");
  });
});

describe("GBP", () => {
  it("asks for profile details when none are given", async () => {
    const result = await runAudit(gbpAudit, ctx(), { url: HOME });
    expect(codes(result)).toContain("gbp.site.localbusiness_schema_missing");
    expect(codes(result)).toContain("gbp.site.no_profile_link");
    expect(codes(result)).not.toContain("gbp.site.address_missing");
    expect(result.askUser[0]).toContain("Google Business Profile");
  });

  it("checks user-provided profile details", async () => {
    const result = await runAudit(gbpAudit, ctx(), {
      url: HOME,
      profile: {
        name: "Acme Plumbing - Best Plumber Austin TX",
        secondaryCategories: [],
        reviewCount: 6,
        photoCount: 3,
        averageRating: 4.6,
        phone: "(512) 555-0147",
        website: "https://acmeplumbing.test",
      },
    });
    const found = codes(result);
    expect(result.issues.find((issue) => issue.code === "gbp.profile.name_keyword_stuffing")?.tier).toBe("high");
    expect(found).toContain("gbp.profile.reviews_low");
    expect(found).toContain("gbp.profile.photos_low");
    expect(found).toContain("gbp.profile.categories_secondary_missing");
    expect(found).not.toContain("gbp.profile.rating_low");
    expect(found).not.toContain("gbp.profile.phone_mismatch");
    expect(found).not.toContain("gbp.profile.website_mismatch");
  });
});

describe("Schema", () => {
  it("validates markup against page content", async () => {
    const result = await runAudit(schemaAudit, ctx(), { url: HOME, maxPages: 1 });
    const found = codes(result);
    expect(found).toContain("schema.website.missing");
    expect(found).toContain("aeo.faq_schema.missing");
    expect(found).toContain("schema.recommended_property_missing");
    expect(found).not.toContain("schema.organization.missing");
    expect(found).not.toContain("schema.jsonld.invalid");
  });
});

describe("Content opportunities", () => {
  it("finds missing page types, thin pages and stale content", async () => {
    const result = await runAudit(contentOpportunityAudit, ctx(), { url: HOME, priorityTopics: ["drain cleaning", "water heater repair"] });
    const missing = result.issues.find((issue) => issue.code === "content.key_page.missing")?.evidence?.missing as string[];
    expect(missing).toContain("No Case studies, portfolio or testimonials page found");
    expect(missing).toContain('No dedicated page found for "water heater repair"');
    expect(missing).not.toContain('No dedicated page found for "drain cleaning"');
    expect(missing.some((detail) => detail.includes("FAQ"))).toBe(false);
    expect(codes(result)).toContain("content.pages.thin");
    expect(codes(result)).toContain("content.blog.stale");
  });

  it("turns Search Console rows into a few opportunities", async () => {
    const page = `${ORIGIN}/services/drain-cleaning/`;
    const result = await runAudit(contentOpportunityAudit, ctx(), {
      url: HOME,
      priorityTopics: ["drain cleaning"],
      searchRows: [
        { query: "drain cleaning austin", page, clicks: 4, impressions: 900, ctr: 0.004, position: 11.2 },
        { query: "emergency plumber austin", page: HOME, clicks: 3, impressions: 1200, ctr: 0.0025, position: 4.1 },
        { query: "how to unclog a main sewer line", page: HOME, clicks: 1, impressions: 300, ctr: 0.003, position: 14 },
        { query: "plumber near me", page: HOME, clicks: 30, impressions: 600, ctr: 0.05, position: 6 },
        { query: "plumber near me", page, clicks: 20, impressions: 500, ctr: 0.04, position: 7 },
      ],
    });
    const found = codes(result);
    expect(found).toContain("content.gsc.striking_distance");
    expect(found).toContain("content.gsc.low_ctr");
    expect(found).toContain("content.gsc.question_queries");
    expect(found).toContain("content.gsc.cannibalization");
    expect(result.issues.find((issue) => issue.code === "content.gsc.cannibalization")?.tier).toBe("high");
  });
});

describe("Full audit", () => {
  it("runs every check over one shared cache and merges issues by risk", async () => {
    const fetcher = siteFetcher();
    const full = await runFullAudit(createAuditContext({ fetcher }), { url: HOME });
    expect(full.errors).toEqual([]);
    expect(full.results).toHaveLength(8);
    expect(full.issues[0]?.tier).toBe("high");
    const homeFetches = fetcher.calls.filter((call) => call === `GET ${HOME}`);
    expect(homeFetches).toHaveLength(1);
  });

  it("reports an unreachable site clearly", async () => {
    const offline = createAuditContext({
      fetcher: async (url) => ({ requestedUrl: url, url, status: 0, ok: false, headers: {}, redirects: [], body: "", bytes: 0, truncated: false, timingMs: 5, error: "ENOTFOUND" }),
    });
    await expect(runAudit(seoHealthAudit, offline, { url: "https://nowhere.test" })).rejects.toThrow(/Could not reach/);
  });
});

describe("brand detection", () => {
  it("does not treat a title tagline as a second brand when og:site_name exists", async () => {
    const { brandCandidates } = await import("@/audits/shared");
    const { extractPage } = await import("@/core/extract");
    const page = extractPage({
      requestedUrl: "https://x.test/",
      url: "https://x.test/",
      status: 200,
      ok: true,
      headers: { "content-type": "text/html" },
      redirects: [],
      body: '<html><head><title>Local SEO Agency | Digital Marketing Services at Scale</title><meta property="og:site_name" content="Incrementors"></head><body></body></html>',
      bytes: 100,
      truncated: false,
      timingMs: 1,
    });
    expect(brandCandidates(page)).toEqual(["Incrementors"]);
  });
});
