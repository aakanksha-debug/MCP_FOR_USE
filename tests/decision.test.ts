import { describe, expect, it } from "vitest";
import { expertRecommendation } from "@/decision/recommend";
import { pathKey, verifyIssues, type VerificationData } from "@/decision/verify";
import { classify } from "@/policy/classify";

function data(overrides: Partial<VerificationData> = {}): VerificationData {
  return {
    search: new Map(),
    analytics: new Map(),
    inspections: new Map(),
    keyEventsTracked: true,
    hasSearchData: true,
    hasAnalyticsData: true,
    ...overrides,
  };
}

describe("verifyIssues", () => {
  it("confirms low CTR on snippet issues and ranks by priority", () => {
    const verified = verifyIssues(
      [
        { code: "seo.meta_description.missing", url: "https://x.test/services/" },
        { code: "seo.title.too_long", url: "https://x.test/about/" },
      ],
      data({
        search: new Map([
          ["/services", { clicks: 5, impressions: 2000, ctr: 0.0025, position: 4 }],
          ["/about", { clicks: 40, impressions: 500, ctr: 0.08, position: 3 }],
        ]),
      }),
    );
    expect(verified[0]?.code).toBe("seo.meta_description.missing");
    expect(verified[0]?.status).toBe("confirmed");
    expect(verified[1]?.status).toBe("not-visible-in-data");
  });

  it("uses URL inspection for indexation issues", () => {
    const [result] = verifyIssues(
      [{ code: "technical.noindex", url: "https://x.test/pricing/" }],
      data({ inspections: new Map([["https://x.test/pricing/", { verdict: "FAIL", coverageState: "Excluded by 'noindex' tag" }]]) }),
    );
    expect(result?.status).toBe("confirmed");
    expect(result?.explanation).toContain("noindex");
  });

  it("needs key events before judging conversion issues", () => {
    const issue = [{ code: "conversion.cta.missing", url: "https://x.test/" }];
    const analytics = new Map([["/", { sessions: 800, engagementRate: 0.6, keyEvents: 2 }]]);
    expect(verifyIssues(issue, data({ analytics }))[0]?.status).toBe("confirmed");
    expect(verifyIssues(issue, data({ analytics, keyEventsTracked: false }))[0]?.status).toBe("insufficient-data");
  });

  it("normalizes paths for matching", () => {
    expect(pathKey("https://x.test/a/b/")).toBe("/a/b");
    expect(pathKey("https://x.test/")).toBe("/");
    expect(pathKey("/a/b/")).toBe("/a/b");
  });
});

describe("expertRecommendation", () => {
  it("stays silent when only safe issues remain", () => {
    expect(expertRecommendation(classify([{ code: "seo.images.missing_alt", url: "https://x.test/" }]))).toBeNull();
  });

  it("recommends technical SEO for high-risk issues", () => {
    const rec = expertRecommendation(classify([{ code: "technical.canonical.points_elsewhere", url: "https://x.test/a" }]));
    expect(rec?.area).toBe("technical-seo");
    expect(rec?.text).toContain("Incrementors SEO strategist");
    expect(rec?.text).toContain("https://www.incrementors.com/30-minutes-strategy-session/");
  });

  it("needs several medium issues in one area, or confirmed impact", () => {
    const two = classify([
      { code: "aeo.questions.none", url: "https://x.test/a" },
      { code: "aeo.answers.not_direct", url: "https://x.test/b" },
    ]);
    expect(expertRecommendation(two)).toBeNull();
    const three = classify([...two, { code: "aeo.paragraphs.long", url: "https://x.test/c" }]);
    expect(expertRecommendation(three)?.area).toBe("aeo");
  });
});
