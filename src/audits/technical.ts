import { fetchCoreWebVitals } from "@/integrations/pagespeed";
import { isDisallowed } from "@/core/robots";
import { comparableUrl, findBrokenInternalLinks, isOkHtml, loadTarget } from "./shared";
import { emptyOutput, type AuditModule } from "./types";

export interface TechnicalInput {
  url: string;
  /** Runs Google PageSpeed Insights (slower, about 10-30 seconds). */
  includeCoreWebVitals?: boolean;
}

const HREFLANG_CODE = /^(x-default|[a-z]{2,3}(-([a-z]{4}|[a-z]{2}|\d{3}))?)$/i;

export const technicalAudit: AuditModule<TechnicalInput> = {
  id: "technical",
  name: "Technical Website Check",
  async run(ctx, input) {
    const output = emptyOutput();
    const { url, page } = await loadTarget(ctx, input.url);
    const final = new URL(page.url);
    const origin = final.origin;
    const add = (code: string, detail?: string, evidence?: Record<string, unknown>, target = page.url) =>
      output.findings.push({ code, url: target, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) });

    const vitalsPromise =
      input.includeCoreWebVitals && isOkHtml(page)
        ? fetchCoreWebVitals(page.url, Math.min(40_000, Math.max(ctx.timeLeftMs() - 3_000, 5_000)))
        : null;

    if (page.status >= 400) add("technical.status.error", `HTTP ${page.status}`);
    else output.passed.push(`Page responds with HTTP ${page.status}`);

    // HTTPS and redirects
    if (final.protocol === "http:") {
      add("technical.https.missing", "The final URL is served over plain HTTP");
    } else {
      output.passed.push("Served over HTTPS");
      const httpUrl = `http://${final.host}${final.pathname}`;
      const httpVersion = await ctx.fetch(httpUrl, { followRedirects: false, maxBytes: 4096 });
      const location = httpVersion.headers.location;
      if (httpVersion.status >= 200 && httpVersion.status < 300) {
        add("technical.https.no_redirect", `${httpUrl} returns ${httpVersion.status} instead of redirecting`);
      } else if (httpVersion.status >= 300 && httpVersion.status < 400 && location) {
        const target = new URL(location, httpUrl);
        if (target.protocol !== "https:") add("technical.https.no_redirect", `HTTP redirects to ${target.toString()}, not HTTPS`);
      }
      if (!page.headers["strict-transport-security"]) add("technical.hsts.missing");
    }
    if (page.redirects.length >= 2) {
      add(
        "technical.redirect.chain",
        `${page.redirects.length} hops: ${[...page.redirects.map((hop) => `${hop.url} (${hop.status})`), page.url].join(" → ")}`,
        { hops: page.redirects },
        url,
      );
    }

    const alternateHost = final.hostname.startsWith("www.") ? final.hostname.slice(4) : `www.${final.hostname}`;
    const alternate = await ctx.fetch(`${final.protocol}//${alternateHost}/`, { followRedirects: false, maxBytes: 4096 });
    if (alternate.status >= 200 && alternate.status < 300) {
      add("technical.www.duplicate", `${alternateHost} returns ${alternate.status} without redirecting to ${final.hostname}`);
    } else if (alternate.status >= 300 && alternate.status < 400) {
      output.passed.push(`${alternateHost} redirects to the main hostname`);
    }

    // Crawl directives
    const robots = await ctx.robots(origin);
    if (!robots.found) add("technical.robots_txt.missing", `${robots.url} returned ${robots.status || "no response"}`, undefined, robots.url);
    else if (isDisallowed(robots.parsed, "Googlebot", "/")) {
      add("technical.robots_txt.blocks_all", "Googlebot is disallowed from /", undefined, robots.url);
    } else output.passed.push("robots.txt allows search engines to crawl the homepage");

    const sitemap = await ctx.sitemap(origin);
    if (!sitemap.found) add("technical.sitemap.missing", undefined, undefined, `${origin}/sitemap.xml`);
    else {
      output.passed.push(`XML sitemap found with ${sitemap.entries.length} URLs`);
      if (robots.found && !sitemap.listedInRobots) {
        add("technical.sitemap.not_in_robots", `Sitemap at ${sitemap.sources[0]}`, { sitemap: sitemap.sources[0] }, robots.url);
      }
    }

    if (isOkHtml(page)) {
      const robotsDirectives = `${page.robotsMeta ?? ""} ${page.xRobotsTag ?? ""}`.toLowerCase();
      if (robotsDirectives.includes("noindex")) add("technical.noindex", `robots directive: "${robotsDirectives.trim()}"`);
      else output.passed.push("Page is indexable (no noindex)");

      const canonicals = [...new Set(page.canonicals.map(comparableUrl))];
      if (canonicals.length === 0) add("technical.canonical.missing");
      else if (canonicals.length > 1) add("technical.canonical.multiple", page.canonicals.join(", "));
      else if (canonicals[0] !== comparableUrl(page.url)) {
        add("technical.canonical.points_elsewhere", `Canonical: ${page.canonicals[0]}`, { canonical: page.canonicals[0] });
      } else output.passed.push("Self-referencing canonical is set");

      if (!page.viewport) add("technical.viewport.missing");
      if (!page.lang) add("technical.lang.missing");
      if (page.mixedContent.length) add("technical.mixed_content", `${page.mixedContent.length} insecure resources`, { resources: page.mixedContent });

      if (page.timingMs > 2_000) add("technical.response.slow", `HTML took ${page.timingMs} ms to download`);
      if (page.bytes > 1_500_000 || page.truncated) add("technical.html.large", `${Math.round(page.bytes / 1024)} KB of HTML`);
      if (!page.headers["content-encoding"] && page.bytes > 10_000) add("technical.compression.missing");

      const noDimensions = page.images.filter((image) => !image.hasDimensions);
      if (page.images.length >= 4 && noDimensions.length / page.images.length > 0.5) {
        add("technical.images.no_dimensions", `${noDimensions.length} of ${page.images.length} images`);
      }

      if (page.hreflang.length) {
        const invalid = page.hreflang.filter((entry) => !HREFLANG_CODE.test(entry.lang) || !entry.href);
        const selfReferenced = page.hreflang.some((entry) => comparableUrl(entry.href) === comparableUrl(page.url));
        if (invalid.length || !selfReferenced) {
          add(
            "technical.hreflang.invalid",
            [invalid.length ? `invalid codes: ${invalid.map((e) => e.lang).join(", ")}` : "", selfReferenced ? "" : "no self-referencing entry"]
              .filter(Boolean)
              .join("; "),
          );
        }
      }

      const broken = await findBrokenInternalLinks(ctx, [page], 20);
      output.findings.push(...broken.findings);
      if (!broken.findings.length) output.passed.push(`No broken internal links among ${broken.checked} checked on this page`);
    }

    if (vitalsPromise) {
      const vitals = await vitalsPromise;
      if ("error" in vitals) output.notes.push(`Core Web Vitals unavailable: ${vitals.error}`);
      else {
        output.facts.coreWebVitals = vitals;
        if (vitals.overall === "SLOW") add("technical.cwv.poor", `${vitals.source === "field" ? "Real-user" : "Lab"} data rated SLOW`, vitals as unknown as Record<string, unknown>);
        else if (vitals.overall === "AVERAGE") add("technical.cwv.needs_improvement", `${vitals.source === "field" ? "Real-user" : "Lab"} data rated AVERAGE`, vitals as unknown as Record<string, unknown>);
        else output.passed.push("Core Web Vitals look good");
      }
    } else {
      output.notes.push("Core Web Vitals were not checked. Run again with includeCoreWebVitals=true for PageSpeed data.");
    }

    output.facts = {
      ...output.facts,
      finalUrl: page.url,
      status: page.status,
      redirects: page.redirects,
      responseTimeMs: page.timingMs,
      htmlKb: Math.round(page.bytes / 1024),
      robotsTxt: robots.found,
      sitemap: sitemap.found ? { sources: sitemap.sources, urls: sitemap.entries.length } : null,
      server: page.headers.server,
    };
    output.notes.push("Response time is measured from the audit server and is only a rough indicator.");
    return output;
  },
};
