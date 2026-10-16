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

  it("prepares exact fixes for safe issues with platform guidance", async () => {
    const results = await run([
      { code: "seo.meta_description.missing", url: HOME },
      { code: "aeo.faq_schema.missing", url: HOME },
      { code: "technical.sitemap.not_in_robots", url: `${ORIGIN}/robots.txt` },
      { code: "seo.links.broken_internal", url: HOME },
      { code: "conversion.phone.not_clickable", url: HOME },
    ]);
    for (const result of results) expect(result.outcome.status, result.code).toBe("ready");

    const meta = results[0]!.outcome;
    if (meta.status !== "ready") throw new Error("expected ready");
    expect(meta.changes[0]?.after).toMatch(/^<meta name="description" content="Acme Plumbing provides/);
    expect(meta.changes[0]?.whereToApply).toContain("SEO plugin");

    const faq = results[1]!.outcome;
    if (faq.status !== "ready") throw new Error("expected ready");
    const json = JSON.parse(faq.changes[0]!.after.replace(/^<script[^>]*>|<\/script>$/g, ""));
    expect(json["@type"]).toBe("FAQPage");
    expect(json.mainEntity).toHaveLength(3);

    const robots = results[2]!.outcome;
    if (robots.status !== "ready") throw new Error("expected ready");
    expect(robots.changes[0]?.after).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(robots.changes[0]?.after).toContain("User-agent: GPTBot");

    const tel = results[4]!.outcome;
    if (tel.status !== "ready") throw new Error("expected ready");
    expect(tel.changes[0]?.after).toBe('<a href="tel:5125550147">(512) 555-0147</a>');
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
