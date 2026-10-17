import { describe, expect, it } from "vitest";
import { createAuditContext } from "@/core/context";
import { altFromFilename, trimToLength } from "@/fixes/generators";
import { prepareFixes } from "@/fixes/plan";
import { ORIGIN, siteFetcher } from "./fixtures/site";

const HOME = `${ORIGIN}/`;
const run = (issues: { code: string; url: string }[], approvedCodes?: string[]) =>
  prepareFixes(createAuditContext({ fetcher: siteFetcher() }), issues, { ...(approvedCodes ? { approvedCodes } : {}), platform: "wordpress" });

describe("prepare_fixes policy", () => {
  it("never prepares high-risk changes", async () => {
    const [result] = await run([{ code: "technical.canonical.points_elsewhere", url: `${ORIGIN}/services/drain-cleaning/` }]);
    expect(result?.outcome.status).toBe("expert-review");
  });

  it("requires approval for medium issues, then drafts", async () => {
    const [pending] = await run([{ code: "conversion.value_prop.unclear", url: HOME }]);
    expect(pending?.outcome.status).toBe("needs-approval");
    const [approved] = await run([{ code: "conversion.value_prop.unclear", url: HOME }], ["conversion.value_prop.unclear"]);
    expect(approved?.outcome.status).toBe("draft");
  });

  it("prepares exact content fixes for minor issues, with publishable requests", async () => {
    const results = await run([
      { code: "seo.meta_description.missing", url: HOME },
      { code: "seo.links.broken_internal", url: HOME },
      { code: "conversion.phone.not_clickable", url: HOME },
      { code: "seo.images.missing_alt", url: HOME },
    ]);
    for (const result of results) expect(result.outcome.status, result.code).toBe("ready");

    const meta = results[0]!.outcome;
    if (meta.status !== "ready") throw new Error("expected ready");
    expect(meta.changes[0]?.after).toMatch(/^Acme Plumbing provides/);
    expect(meta.changes[0]?.whereToApply).toContain("SEO plugin");
    expect(meta.changes[0]?.request).toMatchObject({ kind: "meta-description", pageUrl: HOME });

    const tel = results[2]!.outcome;
    if (tel.status !== "ready") throw new Error("expected ready");
    expect(tel.changes[0]?.request).toEqual({ kind: "tel-link", pageUrl: HOME, text: "(512) 555-0147", href: "tel:5125550147" });

    const alt = results[3]!.outcome;
    if (alt.status !== "ready") throw new Error("expected ready");
    expect(alt.changes.find((change) => change.request?.kind === "image-alt")?.request).toMatchObject({ alt: "Team" });
  });

  it("uses alt text supplied by Claude", async () => {
    const [result] = await prepareFixes(createAuditContext({ fetcher: siteFetcher() }), [{ code: "seo.images.missing_alt", url: HOME }], {
      altText: [{ src: `${ORIGIN}/images/team-photo_1200x800.jpg`, alt: "Three Acme plumbers next to a service van" }],
    });
    if (result?.outcome.status !== "ready") throw new Error("expected ready");
    expect(result.outcome.changes[0]?.after).toBe("Three Acme plumbers next to a service van");
  });

  it("routes snippet, file and theme fixes to an Incrementors strategist", async () => {
    const results = await run([
      { code: "aeo.faq_schema.missing", url: HOME },
      { code: "technical.sitemap.not_in_robots", url: `${ORIGIN}/robots.txt` },
      { code: "technical.lang.missing", url: HOME },
    ]);
    for (const result of results) {
      expect(result.outcome.status, result.code).toBe("expert-review");
      if (result.outcome.status === "expert-review") {
        expect(result.outcome.reason).toContain("Needs expert advice");
        expect(result.outcome.reason).toContain("Incrementors SEO strategist");
      }
    }
  });

  it("reports when a safe issue is no longer present", async () => {
    const [result] = await run([{ code: "seo.title.missing", url: `${ORIGIN}/about/` }]);
    expect(result?.outcome.status).toBe("not-detected");
  });

  it("rejects unknown codes", async () => {
    const [result] = await run([{ code: "seo.unknown", url: HOME }]);
    expect(result?.outcome.status).toBe("error");
  });
});

describe("fix helpers", () => {
  it("derives alt text from meaningful file names only", () => {
    expect(altFromFilename("https://x.test/images/team-photo_1200x800.jpg")).toBe("Team");
    expect(altFromFilename("https://x.test/uploads/red-brick-chimney-repair.webp")).toBe("Red brick chimney repair");
    expect(altFromFilename("https://x.test/a8f3c9d2e1b4.png")).toBe("");
  });

  it("trims at word boundaries", () => {
    expect(trimToLength("one two three four five", 12)).toBe("one two");
    expect(trimToLength("Short.", 50)).toBe("Short.");
  });
});

describe("suggestMetaDescription", () => {
  it("combines paragraphs to reach a useful length", async () => {
    const { suggestMetaDescription } = await import("@/fixes/generators");
    const { extractPage } = await import("@/core/extract");
    const page = extractPage({
      requestedUrl: "https://x.test/",
      url: "https://x.test/",
      status: 200,
      ok: true,
      headers: { "content-type": "text/html" },
      redirects: [],
      body: "<html><body><main><h1>Welcome</h1><p>Demo Roofing fixes and replaces roofs in Denver.</p><p>Call 303 555 0199 for a free inspection from a licensed, insured crew with 20 years of local experience.</p></main></body></html>",
      bytes: 100,
      truncated: false,
      timingMs: 1,
    });
    const description = suggestMetaDescription(page);
    expect(description.length).toBeGreaterThanOrEqual(120);
    expect(description.length).toBeLessThanOrEqual(155);
    expect(description.startsWith("Demo Roofing")).toBe(true);
  });
});

describe("suggestTitle", () => {
  async function page(html: string) {
    const { extractPage } = await import("@/core/extract");
    return extractPage({ requestedUrl: "https://x.test/", url: "https://x.test/", status: 200, ok: true, headers: { "content-type": "text/html" }, redirects: [], body: html, bytes: 1, truncated: false, timingMs: 1 });
  }

  it("shortens an over-long title to its main part plus brand", async () => {
    const { suggestTitle } = await import("@/fixes/generators");
    const data = await page(
      '<html><head><title>Local & Ecommerce SEO Agency | Digital Marketing Services at Scale</title><meta property="og:site_name" content="Incrementors"></head><body><h1>BOOST YOUR SALES<br>IN THE NEXT 6 MONTHS</h1></body></html>',
    );
    expect(suggestTitle(data)).toBe("Local & Ecommerce SEO Agency | Incrementors");
  });

  it("builds a missing title from a shouted H1 in readable case, keeping line-break spaces", async () => {
    const { suggestTitle } = await import("@/fixes/generators");
    const data = await page('<html><head><meta property="og:site_name" content="Acme"></head><body><h1>BOOST YOUR SALES<br>IN THE NEXT 6 MONTHS</h1></body></html>');
    expect(data.h1s[0]).toBe("BOOST YOUR SALES IN THE NEXT 6 MONTHS");
    expect(suggestTitle(data)).toBe("Boost Your Sales in the Next 6 Months | Acme");
  });
});
