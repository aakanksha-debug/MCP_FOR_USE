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
