import type { PageData } from "@/core/extract";
import { LOCAL_BUSINESS_TYPES } from "./schema";
import { brandCandidates, digitsOnly, isOkHtml, loadTarget, normalizeBrand } from "./shared";
import { emptyOutput, type AuditModule } from "./types";

/**
 * Google Business Profile details the user reads from their profile. GBP data
 * is not publicly available through an API without owner access, so Claude
 * asks the user for these values.
 */
export interface GbpProfileDetails {
  name?: string;
  primaryCategory?: string;
  secondaryCategories?: string[];
  description?: string;
  hoursSet?: boolean;
  phone?: string;
  website?: string;
  address?: string;
  serviceAreaBusiness?: boolean;
  photoCount?: number;
  reviewCount?: number;
  averageRating?: number;
  /** Share of reviews that have an owner reply, 0-100. */
  reviewReplyPercent?: number;
  /** Days since the last profile post. */
  daysSinceLastPost?: number;
  servicesListed?: boolean;
}

export interface GbpInput {
  url: string;
  profile?: GbpProfileDetails;
}

const STUFFING_WORDS = /\b(best|top|cheap|cheapest|affordable|near me|#1|no\.? ?1|24\/7|emergency|leading|trusted|certified|licensed)\b/i;

export function profileFindings(profile: GbpProfileDetails, site: { url: string; brands: string[]; phones: string[] }) {
  const findings: { code: string; url: string; detail?: string }[] = [];
  const add = (code: string, detail?: string) => findings.push({ code, url: site.url, ...(detail ? { detail } : {}) });

  if (profile.name) {
    const siteBrands = site.brands.map(normalizeBrand).filter(Boolean);
    const profileName = normalizeBrand(profile.name);
    // "Acme Plumbing - Austin TX" style names add keywords after a separator.
    const hasExtraSegment =
      profile.name.split(/\s[|\-–—]\s|,\s|\s\|/).length > 1 && siteBrands.length > 0 && !siteBrands.includes(profileName);
    if (STUFFING_WORDS.test(profile.name) || hasExtraSegment) {
      add("gbp.profile.name_keyword_stuffing", `Profile name: "${profile.name}"`);
    } else if (siteBrands.length && !siteBrands.some((brand) => brand.includes(profileName) || profileName.includes(brand))) {
      add("gbp.profile.name_mismatch", `Profile "${profile.name}" vs website "${site.brands.join(" / ")}"`);
    }
  }
  if (profile.secondaryCategories && profile.secondaryCategories.length === 0) add("gbp.profile.categories_secondary_missing");
  if (profile.description !== undefined && profile.description.trim().length < 250) {
    add("gbp.profile.description_weak", `${profile.description.trim().length} characters`);
  }
  if (profile.hoursSet === false) add("gbp.profile.hours_missing");
  if (profile.photoCount !== undefined && profile.photoCount < 10) add("gbp.profile.photos_low", `${profile.photoCount} photos`);
  if (profile.reviewCount !== undefined && profile.reviewCount < 20) add("gbp.profile.reviews_low", `${profile.reviewCount} reviews`);
  if (profile.averageRating !== undefined && profile.averageRating < 4) add("gbp.profile.rating_low", `${profile.averageRating} average rating`);
  if (profile.reviewReplyPercent !== undefined && profile.reviewReplyPercent < 50) {
    add("gbp.profile.review_replies_low", `About ${profile.reviewReplyPercent}% of reviews have replies`);
  }
  if (profile.daysSinceLastPost !== undefined && profile.daysSinceLastPost > 30) add("gbp.profile.posts_inactive", `Last post ${profile.daysSinceLastPost} days ago`);
  if (profile.servicesListed === false) add("gbp.profile.services_missing");
  if (profile.website) {
    try {
      const profileHost = new URL(/^https?:/i.test(profile.website) ? profile.website : `https://${profile.website}`).hostname.replace(/^www\./, "");
      const siteHost = new URL(site.url).hostname.replace(/^www\./, "");
      if (profileHost !== siteHost) add("gbp.profile.website_mismatch", `Profile links to ${profileHost}`);
    } catch {
      add("gbp.profile.website_mismatch", `Profile website "${profile.website}" is not a valid URL`);
    }
  }
  if (profile.phone && site.phones.length && !site.phones.includes(digitsOnly(profile.phone))) {
    add("gbp.profile.phone_mismatch", `Profile phone ${profile.phone} is not shown on the website`);
  }
  return findings;
}

function contactPageUrl(page: PageData): string | undefined {
  return page.links.find((link) => link.internal && (/\bcontact\b/i.test(link.text) || /\/contact/i.test(link.href)))?.href;
}

const PROFILE_FIELDS =
  "exact business name, primary and secondary categories, description, whether hours are set, number of photos, review count and average rating, roughly what share of reviews have replies, days since the last post, whether services are listed, and the website and phone shown on the profile";

export const gbpAudit: AuditModule<GbpInput> = {
  id: "gbp",
  name: "GBP Health",
  async run(ctx, input) {
    const output = emptyOutput();
    const { page } = await loadTarget(ctx, input.url);
    const contactUrl = isOkHtml(page) ? contactPageUrl(page) : undefined;
    const contact = contactUrl ? await ctx.page(contactUrl) : undefined;
    const pages = [page, ...(contact && isOkHtml(contact) ? [contact] : [])].filter(isOkHtml);
    const add = (code: string, detail?: string, evidence?: Record<string, unknown>) =>
      output.findings.push({ code, url: page.url, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) });

    const phones = [...new Set(pages.flatMap((p) => [...p.phonesInText, ...p.telLinks]).map(digitsOnly).filter((d) => d.length >= 10))];
    const serviceArea = input.profile?.serviceAreaBusiness === true;

    if (!phones.length) add("gbp.site.phone_missing");
    else output.passed.push(`Phone number shown on the website (${phones.length} distinct)`);
    if (phones.length > 2) {
      add(
        "gbp.site.nap_inconsistent",
        `${phones.length} different phone numbers: ${phones.join(", ")}. Fine if each belongs to a separate location; otherwise keep one primary number.`,
        { phones },
      );
    }

    const hasAddress = pages.some((p) => p.hasAddress);
    if (!hasAddress && !serviceArea) add("gbp.site.address_missing");
    else if (hasAddress) output.passed.push("A business address appears on the website");

    const hasLocalSchema = pages.some((p) => p.schemaTypes.some((type) => LOCAL_BUSINESS_TYPES.has(type)));
    if (!hasLocalSchema) add("gbp.site.localbusiness_schema_missing");
    else output.passed.push("LocalBusiness structured data is present");

    const profileLinks = [...new Set(pages.flatMap((p) => p.profileLinks))];
    if (!profileLinks.length) add("gbp.site.no_profile_link");
    else output.passed.push("Website links to Google Maps / the business profile");
    if (!serviceArea && !pages.some((p) => p.mapEmbeds.length) && !profileLinks.length) add("gbp.site.no_map");

    if (input.profile) {
      output.findings.push(...profileFindings(input.profile, { url: page.url, brands: brandCandidates(page), phones }));
    } else {
      output.askUser.push(
        `To check the profile itself, ask the user to open their Google Business Profile and share: ${PROFILE_FIELDS}. Then run this check again with those details.`,
      );
      output.notes.push("Only website-side local signals were checked. Profile data is not publicly available via API without owner access.");
    }

    output.facts = {
      phonesOnSite: phones,
      addressOnSite: hasAddress,
      localBusinessSchema: hasLocalSchema,
      profileLinks,
      mapEmbedded: pages.some((p) => p.mapEmbeds.length > 0),
      contactPage: contactUrl ?? null,
      profileProvided: Boolean(input.profile),
    };
    return output;
  },
};
