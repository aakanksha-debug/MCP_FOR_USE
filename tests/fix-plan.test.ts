import { describe, expect, it } from "vitest";
import { detectPlatform } from "@/core/platform-detect";
import { buildFixPlan, formatFixPlan } from "@/fixes/application-plan";
import { classify } from "@/policy/classify";

describe("detectPlatform", () => {
  it.each([
    ['<link rel="stylesheet" href="/wp-content/themes/x/style.css">', {}, "wordpress"],
    ["<script>Shopify.theme = {}</script>", {}, "shopify"],
    ['<meta name="generator" content="Wix.com Website Builder">', {}, "wix"],
    ['<html data-wf-site="123">', {}, "webflow"],
    ['<meta property="og:image" content="https://x.lovable.app/preview.png">', {}, "lovable"],
    ['<script src="/_next/static/chunks/main.js"></script>', {}, "nextjs"],
    ["<p>Hello</p>", {}, "unknown"],
    ["<p>Hello</p>", { link: '<https://x.test/wp-json/>; rel="https://api.w.org/"' }, "wordpress"],
  ])("detects %s", (html, headers, id) => {
    expect(detectPlatform(html, headers as Record<string, string>).id).toBe(id);
  });
});

describe("fix plan", () => {
  const issues = classify([
    { code: "seo.images.missing_alt", url: "https://isawow.test/" },
    { code: "seo.title.too_long", url: "https://isawow.test/tools/" },
    { code: "aeo.questions.none", url: "https://isawow.test/" },
    { code: "seo.content.thin", url: "https://isawow.test/book-session" },
    { code: "conversion.phone.missing", url: "https://isawow.test/" },
    { code: "seo.h1.multiple", url: "https://isawow.test/" },
    { code: "gbp.site.localbusiness_schema_missing", url: "https://isawow.test/" },
    { code: "technical.images.no_dimensions", url: "https://isawow.test/" },
  ]);

  it("answers yes, explains access for the platform and asks for real facts", () => {
    const text = formatFixPlan(buildFixPlan("isawow.test", { id: "lovable", name: "Lovable (React app)", kind: "code" }, issues));
    expect(text).toContain("Yes, for most of them. The site runs on **Lovable (React app)**");
    expect(text).toContain("GitHub repository");
    expect(text).toContain("Images are missing alt text");
    expect(text).toContain("3 to 6 real questions customers ask");
    expect(text).toContain("Your phone number");
    expect(text).toContain("nothing gets made up");
    expect(text).toContain("Page has more than one H1");
    expect(text).toContain("### 🔴 Major issues requiring expert advice");
    expect(text).toContain("**No LocalBusiness structured data**: Needs a structured-data code snippet");
    expect(text).toContain("Incrementors SEO strategist");
    expect(text).toContain("Never paste passwords or tokens");
  });

  it("points WordPress sites to connect_website and the approval page", () => {
    const text = formatFixPlan(buildFixPlan("x.test", { id: "wordpress", name: "WordPress", kind: "cms" }, issues));
    expect(text).toContain("connect_website");
    expect(text).toContain("Approve & publish");
  });

  it("asks which CMS when the platform is unknown", () => {
    const text = formatFixPlan(buildFixPlan("x.test", { id: "unknown", name: "Unknown", kind: "unknown" }, issues));
    expect(text).toContain("Tell me which CMS or builder the site uses");
  });
});
