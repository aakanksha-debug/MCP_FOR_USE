import { describe, expect, it } from "vitest";
import { fixGenerator } from "@/fixes/generators";
import { listIssueDefinitions } from "@/policy/catalog";
import { classify } from "@/policy/classify";

describe("issue catalog", () => {
  const definitions = listIssueDefinitions();

  it("has unique codes", () => {
    expect(new Set(definitions.map((d) => d.code)).size).toBe(definitions.length);
  });

  it("only gives fix generators to safe issues, and every one exists", () => {
    for (const definition of definitions) {
      if (definition.fix) {
        expect(definition.tier, definition.code).toBe("safe");
        expect(typeof fixGenerator(definition.fix)).toBe("function");
      }
    }
  });

  it("keeps indexation, canonical and redirect issues high-risk", () => {
    const high = new Set(definitions.filter((d) => d.tier === "high").map((d) => d.code));
    for (const code of ["technical.noindex", "technical.canonical.points_elsewhere", "technical.canonical.missing", "technical.redirect.chain", "technical.robots_txt.blocks_all"]) {
      expect(high.has(code), code).toBe(true);
    }
  });

  it("rejects unknown codes and deduplicates findings", () => {
    expect(() => classify([{ code: "made.up", url: "https://x.test/" }])).toThrow(/Unknown issue code/);
    const issues = classify([
      { code: "seo.title.missing", url: "https://x.test/" },
      { code: "seo.title.missing", url: "https://x.test/" },
      { code: "technical.noindex", url: "https://x.test/" },
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0]?.tier).toBe("high");
    expect(issues[1]?.fixPolicy).toBe("auto-fix");
  });
});

describe("expert-only policy", () => {
  const definitions = listIssueDefinitions();

  it("gives every high-tier issue a reason an expert is needed", () => {
    for (const definition of definitions.filter((d) => d.tier === "high")) {
      expect(definition.expertReason, definition.code).toBeTruthy();
    }
  });

  it("never auto-fixes snippets, files, themes, plugins or server settings", () => {
    const codeLevel = [
      "seo.open_graph.missing",
      "technical.lang.missing",
      "technical.sitemap.not_in_robots",
      "aeo.faq_schema.missing",
      "geo.llms_txt.missing",
      "geo.entity.same_as_missing",
      "schema.website.missing",
      "schema.breadcrumb.missing",
      "gbp.site.localbusiness_schema_missing",
    ];
    for (const code of codeLevel) {
      const definition = definitions.find((d) => d.code === code)!;
      expect(definition.tier, code).toBe("high");
      expect(definition.fix, code).toBeUndefined();
    }
    const fixable = definitions.filter((d) => d.fix).map((d) => d.fix);
    expect(new Set(fixable)).toEqual(new Set(["title", "meta-description", "alt-text", "broken-link", "tel-link"]));
  });
});
