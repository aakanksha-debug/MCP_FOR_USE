import { describe, expect, it } from "vitest";
import { formatAuditResult, GOOGLE_OFFER } from "@/mcp/format";
import type { AuditResult } from "@/core/types";

const result: AuditResult = {
  audit: "seo",
  name: "SEO Health",
  target: "https://x.test/",
  checkedAt: "2026-10-17T00:00:00.000Z",
  score: 90,
  issues: [],
  passed: ["Titles look good"],
  facts: {},
  notes: [],
  askUser: [],
};

describe("audit output", () => {
  it("offers Google Search Console after an audit", () => {
    const text = formatAuditResult(result, null, true);
    expect(text).toContain(GOOGLE_OFFER);
    expect(text).toContain('Say "connect Search Console" to start');
  });

  it("does not offer it once Google is connected", () => {
    expect(formatAuditResult(result, null, false)).not.toContain("Connect Google Search Console");
  });

  it("always ends a single check with the expert advice section and strategist link", () => {
    expect(formatAuditResult(result, null)).toContain("### 🔴 Major issues requiring expert advice (0)");
    const withHigh = formatAuditResult(
      {
        ...result,
        issues: [
          {
            code: "technical.noindex",
            category: "technical",
            tier: "high",
            impact: "high",
            title: "Page is set to noindex",
            why: "It will not appear in Google.",
            recommendation: "Remove the noindex directive if the page should rank.",
            expertise: "technical-seo",
            expertReason: "Indexing changes can remove pages from Google",
            url: "https://x.test/",
          },
        ],
      } as AuditResult,
      null,
    );
    expect(withHigh).toContain("### 🔴 Major issues requiring expert advice (1)");
    expect(withHigh).toContain("- **Page is set to noindex**: Indexing changes can remove pages from Google");
    expect(withHigh).toContain("https://www.incrementors.com/30-minutes-strategy-session/");
  });

  it("keeps the score line and first heading on separate lines", () => {
    expect(formatAuditResult(result, null)).toMatch(/· 🟢 0\n\nNo issues found/);
  });
});
