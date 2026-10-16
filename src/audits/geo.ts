import { AI_CRAWLERS, isDisallowed } from "@/core/robots";
import { LOCAL_BUSINESS_TYPES } from "./schema";
import { brandCandidates, isHomepage, isOkHtml, loadTarget, normalizeBrand } from "./shared";
import { emptyOutput, type AuditModule } from "./types";

export interface GeoInput {
  url: string;
}

const ORGANIZATION_LIKE = /Organization|Corporation|OnlineBusiness|OnlineStore/;
const ABOUT_LINK = /\b(about|who we are|our story|our team|company|meet the team)\b/i;

export const geoAudit: AuditModule<GeoInput> = {
  id: "geo",
  name: "GEO Check",
  async run(ctx, input) {
    const output = emptyOutput();
    const { page } = await loadTarget(ctx, input.url);
    const origin = new URL(page.url).origin;
    const add = (code: string, detail?: string, evidence?: Record<string, unknown>, target = page.url) =>
      output.findings.push({ code, url: target, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) });

    // AI crawler access
    const robots = await ctx.robots(origin);
    const crawlerAccess = AI_CRAWLERS.map((crawler) => ({
      ...crawler,
      blocked: robots.found && isDisallowed(robots.parsed, crawler.agent, "/"),
    }));
    const blockedVisibility = crawlerAccess.filter((crawler) => crawler.blocked && crawler.purpose !== "training");
    const blockedTraining = crawlerAccess.filter((crawler) => crawler.blocked && crawler.purpose === "training");
    if (blockedVisibility.length) {
      add(
        "geo.ai_crawlers.blocked",
        `Blocked: ${blockedVisibility.map((crawler) => `${crawler.agent} (${crawler.owner})`).join(", ")}`,
        { blocked: blockedVisibility.map((crawler) => crawler.agent) },
        robots.url,
      );
    } else {
      output.passed.push("AI search and answer crawlers can access the site");
    }
    if (blockedTraining.length) {
      output.notes.push(
        `Training-only crawlers are blocked (${blockedTraining.map((c) => c.agent).join(", ")}). That is a valid business choice and does not stop AI search citations.`,
      );
    }

    // llms.txt
    const llms = await ctx.fetch(`${origin}/llms.txt`, { accept: "text/plain,text/markdown,*/*;q=0.5", maxBytes: 256 * 1024 });
    const hasLlms = llms.ok && !/^\s*</.test(llms.body) && llms.body.trim().length > 20;
    if (hasLlms) output.passed.push("llms.txt is published");
    else add("geo.llms_txt.missing", undefined, undefined, `${origin}/llms.txt`);

    if (!isOkHtml(page)) {
      output.notes.push(`The page returned HTTP ${page.status}, so on-page checks were skipped.`);
      output.facts = { crawlerAccess };
      return output;
    }

    // Rendering: AI crawlers mostly read raw HTML.
    if (page.bodyWordCount < 80 && page.scriptCount >= 5) {
      add("geo.rendering.js_dependent", `Only about ${page.bodyWordCount} words in the raw HTML with ${page.scriptCount} scripts`);
    }

    // Entity definition
    const hasOrganization = page.schemaTypes.some((type) => ORGANIZATION_LIKE.test(type) || LOCAL_BUSINESS_TYPES.has(type));
    if (isHomepage(page.url)) {
      if (!hasOrganization) add("geo.entity.organization_schema_missing");
      else {
        const hasSameAs = page.jsonLd.some((block) => block.raw.includes('"sameAs"'));
        if (!hasSameAs && page.socialLinks.length) {
          add("geo.entity.same_as_missing", `${page.socialLinks.length} profile links found on the page`, { profiles: page.socialLinks });
        } else if (hasSameAs) output.passed.push("Organization markup links official profiles (sameAs)");
      }
    }
    const aboutLink = page.links.find((link) => link.internal && (ABOUT_LINK.test(link.text) || /\/(about|company|team|who-we-are)/i.test(link.href)));
    if (!aboutLink) add("geo.entity.about_page_missing");
    else output.passed.push(`About page linked: ${aboutLink.href}`);

    const brands = brandCandidates(page);
    const normalized = [...new Set(brands.map(normalizeBrand).filter(Boolean))];
    const conflicting = normalized.filter((name) => !normalized.some((other) => other !== name && (other.includes(name) || name.includes(other))));
    if (normalized.length >= 2 && conflicting.length >= 2) add("geo.entity.name_inconsistent", `Variants: ${brands.join(" / ")}`, { names: brands });

    // Content signals
    const articleLike =
      page.schemaTypes.some((type) => /Article|BlogPosting/.test(type)) ||
      /\/(blog|news|insights|guides?|articles?|resources)\//i.test(page.url);
    if (articleLike) {
      if (!page.author) add("geo.content.author_missing");
      if (!page.datePublished && !page.dateModified) add("geo.content.dates_missing");
    }
    if (page.wordCount > 300 && page.numberMentions < 2 && page.externalCitationLinks === 0) {
      add("geo.content.no_evidence", `${page.numberMentions} specific figures and no outbound source links`);
    }
    if (isHomepage(page.url)) {
      // Flags openings that are very short, or that never name a brand the site uses elsewhere.
      const opening = [page.h1s[0] ?? "", page.firstParagraph ?? ""].join(" ").trim();
      const namesBrand = !brands.length || brands.some((brand) => opening.toLowerCase().includes(brand.toLowerCase()));
      if (opening.split(/\s+/).length < 8 || !namesBrand) {
        add("geo.content.summary_unclear", opening ? `Opening text: "${opening.slice(0, 160)}"` : "No opening text found");
      }
    }

    output.facts = {
      crawlerAccess: crawlerAccess.map(({ agent, owner, purpose, blocked }) => ({ agent, owner, purpose, blocked })),
      llmsTxt: hasLlms,
      brandNames: brands,
      officialProfiles: page.socialLinks,
      schemaTypes: page.schemaTypes,
    };
    output.notes.push("The opening-summary and evidence checks are heuristics; treat them as prompts for review.");
    return output;
  },
};
