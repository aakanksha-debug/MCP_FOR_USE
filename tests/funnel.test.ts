import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFullAudit } from "@/audits";
import { buildDeepAudit, formatDeepAudit } from "@/analysis/deep-audit";
import { analyzeSearch, formatSearchAnalysis, type SearchAnalysisInput } from "@/analysis/search-performance";
import { analyzeTraffic, formatTrafficAnalysis, type TrafficInput } from "@/analysis/traffic";
import { createAuditContext } from "@/core/context";
import { expertConversion, nextAfterAudit, nextAfterSearch } from "@/funnel/stages";
import { formatAuditSummary, groupIssues } from "@/mcp/format";
import { classify } from "@/policy/classify";
import { ORIGIN, ROUTES, siteFetcher } from "./fixtures/site";

const SITE = "https://shop.test/";

describe("Stage 1 summary", () => {
  it("shows overall and category scores, an opportunity count and only the top findings", async () => {
    const full = await runFullAudit(createAuditContext({ fetcher: siteFetcher() }), { url: `${ORIGIN}/` });
    const text = formatAuditSummary(full, false);
    expect(text).toMatch(/\*\*Overall Website Score: \d+\/100\*\*/);
    expect(text).toMatch(/^- SEO: \d+$/m);
    expect(text).toMatch(/^- AEO: \d+$/m);
    expect(text).toMatch(/We found \*\*\d+ opportunities\*\*, including \*\*\d+ low-risk issues?\*\*/);
    expect(text).toContain("### Top 5 findings");
    expect(text.match(/^\d\. (🟢|🟡|🔴) \*\*/gm)).toHaveLength(5);
    expect(text).toContain("Next step: safe fixes");
    expect(text).toMatch(/I found \*\*\d+ issues? that can be safely fixed\*\*/);
    expect(groupIssues(full.issues).length).toBeLessThan(full.issues.length + 1);
  });

  it("leaves Google Business Profile out for sites without local signals", async () => {
    const routes = { ...ROUTES };
    routes[`${ORIGIN}/contact/`] = { body: "<html><body><main><h1>Contact</h1><p>Email us.</p><a href='mailto:a@b.test'>a@b.test</a></main></body></html>", headers: { "content-type": "text/html" } };
    const full = await runFullAudit(createAuditContext({ fetcher: siteFetcher(routes) }), { url: `${ORIGIN}/`, checks: ["seo", "gbp"] });
    expect(full.results.map((result) => result.audit)).toEqual(["seo", "gbp"]);
    const nonLocal = await runFullAudit(createAuditContext({ fetcher: siteFetcher(routes) }), { url: `${ORIGIN}/` });
    expect(nonLocal.results.some((result) => result.audit === "gbp")).toBe(false);
    expect(nonLocal.skipped[0]?.reason).toContain("Google Business Profile");
  });
});

describe("funnel next steps", () => {
  it("offers safe fixes first, then Search Console, then Analytics", () => {
    expect(nextAfterAudit({ safe: 3, medium: 2, high: 1 }, false)).toContain("I found **3 issues that can be safely fixed**");
    expect(nextAfterAudit({ safe: 0, medium: 2, high: 1 }, false)).toContain("Continue → Connect Google Search Console");
    expect(nextAfterSearch(false)).toContain("Continue → Connect Google Analytics");
  });

  it("recommends an expert only when strategic work exists", () => {
    expect(expertConversion({ safe: 5, medium: 4, high: 3 })).toContain("Connect with an Incrementors SEO/AEO/GEO strategist");
    expect(expertConversion({ safe: 5, medium: 4, high: 3 })).toContain("We identified **12 opportunities**");
    expect(expertConversion({ safe: 2, medium: 1, high: 0 })).not.toContain("Incrementors");
  });
});

const searchInput: SearchAnalysisInput = {
  site: SITE,
  property: "sc-domain:shop.test",
  period: "Last 28 days",
  current: { clicks: 400, impressions: 40_000, ctr: 0.01, position: 12 },
  previous: { clicks: 600, impressions: 38_000, ctr: 0.016, position: 11 },
  pages: [
    { page: `${SITE}`, clicks: 300, impressions: 20_000, ctr: 0.015, position: 6 },
    { page: `${SITE}pricing/`, clicks: 10, impressions: 9_000, ctr: 0.0011, position: 4.2 },
    { page: `${SITE}services/repairs/`, clicks: 5, impressions: 3_000, ctr: 0.0017, position: 14 },
  ],
  queries: [{ query: "shop", clicks: 200, impressions: 5_000, ctr: 0.04, position: 2 }],
  rows: [
    { query: "how much does a repair cost", page: `${SITE}`, clicks: 2, impressions: 900, ctr: 0.002, position: 12 },
    { query: "repair shop near me", page: `${SITE}services/repairs/`, clicks: 3, impressions: 1_500, ctr: 0.002, position: 13 },
  ],
};

const trafficInput: TrafficInput = {
  propertyName: "Shop",
  propertyId: "123",
  period: "Last 28 days",
  current: { sessions: 5_000, users: 3_800, engagementRate: 0.55, keyEvents: 60 },
  previous: { sessions: 4_500, users: 3_500, engagementRate: 0.57, keyEvents: 55 },
  channels: [
    { channel: "Organic Search", sessions: 2_500, engagementRate: 0.6, keyEvents: 40 },
    { channel: "Direct", sessions: 1_500, engagementRate: 0.5, keyEvents: 15 },
  ],
  landingPages: [
    { path: "/", sessions: 2_000, engagementRate: 0.62, keyEvents: 40 },
    { path: "/pricing/", sessions: 900, engagementRate: 0.31, keyEvents: 0 },
  ],
};

describe("search and traffic analysis", () => {
  it("summarizes Search Console data with trends and opportunities", () => {
    const analysis = analyzeSearch(searchInput);
    expect(analysis.change.clicks).toBe(-33.3);
    expect(analysis.lowCtrPages.map((page) => page.page)).toContain(`${SITE}pricing/`);
    expect(analysis.servicePages[0]?.page).toBe(`${SITE}services/repairs/`);
    const text = formatSearchAnalysis(analysis);
    expect(text).toContain("**Clicks:** 400 (▼ -33.3% vs previous period)");
    expect(text).toContain("Clicks dropped 33.3%");
    expect(text).toContain("Seen but not clicked:** /pricing/");
    expect(text).toContain('"how much does a repair cost"');
  });

  it("summarizes GA4 data and finds weak and non-converting pages", () => {
    const analysis = analyzeTraffic(trafficInput);
    expect(analysis.keyEventsTracked).toBe(true);
    expect(analysis.weakEngagement.map((page) => page.path)).toEqual(["/pricing/"]);
    expect(analysis.noConversions.map((page) => page.path)).toEqual(["/pricing/"]);
    expect(formatTrafficAnalysis(analysis)).toContain("Organic search brings **50.0%** of all sessions");
    const untracked = analyzeTraffic({ ...trafficInput, current: { ...trafficInput.current, keyEvents: 0 }, landingPages: trafficInput.landingPages.map((p) => ({ ...p, keyEvents: 0 })) });
    expect(formatTrafficAnalysis(untracked)).toContain("Conversions aren't tracked");
  });
});

describe("deep data-driven audit", () => {
  it("ranks by business impact using real data and ends with the expert stage", () => {
    const issues = classify([
      { code: "seo.meta_description.length", url: `${SITE}pricing/` },
      { code: "seo.images.missing_alt", url: `${SITE}about/` },
      { code: "technical.canonical.missing", url: `${SITE}` },
    ]);
    const deep = buildDeepAudit({ site: SITE, issues, search: analyzeSearch(searchInput), traffic: analyzeTraffic(trafficInput) });
    const codes = deep.items.map((item) => item.code);
    expect(codes).toContain("data.search.declining");
    expect(codes).toContain("data.page.low_ctr");
    expect(codes).toContain("data.page.weak_engagement");
    expect(codes).toContain("data.service_page.underperforming");
    expect(codes.indexOf("data.page.low_ctr")).toBeLessThan(codes.indexOf("seo.images.missing_alt"));
    expect(deep.counts.high).toBeGreaterThanOrEqual(2);

    const text = formatDeepAudit(deep);
    expect(text).toContain("Based on: website audit + Search Console (Last 28 days) + Google Analytics (Last 28 days)");
    expect(text).toContain("### What matters most (ranked by business impact)");
    expect(text).toContain("🟢 MCP can safely handle");
    expect(text).toContain("🟡 Requires your approval");
    expect(text).toContain("🔴 Strategic / expert work");
    expect(text).toContain("A mistake here can remove pages from Google entirely.");
    expect(text).toContain("Connect with an Incrementors SEO/AEO/GEO strategist");
  });
});

describe("progressive Google consent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("connects Search Console first and adds Analytics to the same connection", async () => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("PUBLIC_BASE_URL", "https://audit.example.test");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
    const scopes = [
      "openid email https://www.googleapis.com/auth/webmasters.readonly",
      "openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly",
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const scope = scopes[call] ?? scopes[1]!;
        call += 1;
        return Response.json({ access_token: `a${call}`, ...(call === 1 ? { refresh_token: "r1" } : {}), expires_in: 3600, scope });
      }),
    );
    const google = await import("@/integrations/google/connections");

    const first = await google.createConnection(["search_console"]);
    const firstUrl = new URL(await google.beginAuthorization(new URL(first.signInUrl).searchParams.get("start")!));
    expect(firstUrl.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/webmasters.readonly");
    await google.completeAuthorization(firstUrl.searchParams.get("state")!, "code1");
    expect(await google.connectionStatus(first.connectionId)).toMatchObject({ searchConsole: true, analytics: false });
    await expect(google.getAccessToken(first.connectionId, "analytics")).rejects.toThrow(/Google Analytics isn't connected yet/);

    const second = await google.createConnection(["analytics"], first.connectionId);
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.adding).toBe(true);
    const secondUrl = new URL(await google.beginAuthorization(new URL(second.signInUrl).searchParams.get("start")!));
    expect(secondUrl.searchParams.get("scope")).toContain("webmasters.readonly");
    expect(secondUrl.searchParams.get("scope")).toContain("analytics.readonly");
    await google.completeAuthorization(secondUrl.searchParams.get("state")!, "code2");
    expect(await google.connectionStatus(first.connectionId)).toMatchObject({ searchConsole: true, analytics: true });
    await expect(google.getAccessToken(first.connectionId, "analytics")).resolves.toBe("a2");
  });
});
