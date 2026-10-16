import { describe, expect, it } from "vitest";
import { isDisallowed, parseRobotsTxt } from "@/core/robots";

const robots = parseRobotsTxt(`
User-agent: *
Disallow: /private/
Allow: /private/public-page
Disallow: /*.pdf$

User-agent: GPTBot
User-agent: CCBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
`);

describe("robots.txt matching", () => {
  it("reads sitemaps and groups with several user agents", () => {
    expect(robots.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(isDisallowed(robots, "GPTBot", "/")).toBe(true);
    expect(isDisallowed(robots, "CCBot", "/anything")).toBe(true);
  });

  it("falls back to * and applies longest-match with allow on ties", () => {
    expect(isDisallowed(robots, "Googlebot", "/")).toBe(false);
    expect(isDisallowed(robots, "Googlebot", "/private/x")).toBe(true);
    expect(isDisallowed(robots, "Googlebot", "/private/public-page")).toBe(false);
  });

  it("supports * and $ wildcards", () => {
    expect(isDisallowed(robots, "Bingbot", "/files/report.pdf")).toBe(true);
    expect(isDisallowed(robots, "Bingbot", "/files/report.pdf?x=1")).toBe(false);
  });

  it("treats an empty Disallow as allow-all", () => {
    expect(isDisallowed(parseRobotsTxt("User-agent: *\nDisallow:"), "Googlebot", "/")).toBe(false);
  });
});
