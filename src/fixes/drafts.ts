import type { PageData } from "@/core/extract";
import { brandCandidates, digitsOnly } from "@/audits/shared";
import { suggestTitle } from "./generators";

/**
 * Drafts for medium (🟡) issues. Only produced after the user approves the
 * issue. Drafts are starting points for Claude and the user to refine, never
 * changes applied blindly. Issues without a specific drafter get guidance so
 * Claude can write the change with the user.
 */

export interface Draft {
  summary: string;
  draft?: string;
  guidance: string[];
}

type Drafter = (page: PageData) => Draft;

const jsonLd = (data: unknown) => `<script type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n</script>`;

function organizationDraft(page: PageData, type: "Organization" | "LocalBusiness"): Draft {
  const brand = brandCandidates(page)[0] ?? "TODO: official business name";
  const phone = page.telLinks[0] ?? page.phonesInText[0];
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": type,
    name: brand,
    url: `${new URL(page.url).origin}/`,
    logo: page.og["og:image"] ?? "TODO: absolute URL of your logo",
    ...(phone ? { telephone: phone } : {}),
    ...(type === "LocalBusiness"
      ? {
          address: {
            "@type": "PostalAddress",
            streetAddress: "TODO",
            addressLocality: "TODO",
            addressRegion: "TODO",
            postalCode: "TODO",
            addressCountry: "TODO",
          },
          openingHours: "TODO e.g. Mo-Fr 09:00-17:00",
        }
      : {}),
    ...(page.socialLinks.length ? { sameAs: page.socialLinks.slice(0, 10) } : {}),
  };
  return {
    summary: `${type} markup prefilled with details found on the site`,
    draft: jsonLd(data),
    guidance: [
      "Replace every TODO with the exact details from your Google Business Profile.",
      type === "LocalBusiness" ? "Use the most specific type that fits (for example Dentist, Plumber, LegalService)." : "Use LocalBusiness instead if customers visit a physical location.",
      "Validate with Google's Rich Results Test before publishing.",
    ],
  };
}

const DRAFTERS: Record<string, Drafter> = {
  "seo.h1.missing": (page) => ({
    summary: "Add one visible H1",
    draft: `<h1>${suggestTitle(page).split(" | ")[0]}</h1>`,
    guidance: ["Place it at the top of the main content. Keep it to one clear statement of the page topic."],
  }),
  "seo.h1.multiple": (page) => ({
    summary: `Keep "${page.h1s[0]}" as the H1 and change the others to H2`,
    draft: page.h1s.slice(1).map((text) => `<h1>${text}</h1>  →  <h2>${text}</h2>`).join("\n"),
    guidance: ["Often caused by a logo or slider using H1 in the theme; fix it in the template."],
  }),
  "seo.title.duplicate": (page) => ({
    summary: "Write a unique title for this page",
    draft: `<title>${suggestTitle(page)}</title>`,
    guidance: ["Lead with what makes this page different from the others sharing the title."],
  }),
  "seo.meta_description.duplicate": (page) => ({
    summary: "Write a unique meta description",
    guidance: [`Summarize this page specifically (${page.h1s[0] ?? page.title ?? page.url}) in 120-160 characters with a reason to click.`],
  }),
  "conversion.cta.missing": () => ({
    summary: "Add a primary call to action",
    draft: '<a href="/contact/" class="button">Get a free quote</a>',
    guidance: [
      "Pick the single action that matters most (call, quote, booking, purchase) and use specific wording.",
      "Place it in the header and after the first section, and repeat it at the end of the page.",
    ],
  }),
  "conversion.cta.not_prominent": (page) => ({
    summary: "Move a call to action into the first screen",
    draft: `<a href="${page.ctas[0]?.href ?? "/contact/"}" class="button">${page.ctas[0]?.text ?? "Contact us"}</a>`,
    guidance: ["Add it to the header and the hero section, next to the main headline."],
  }),
  "conversion.contact.no_contact_link": () => ({
    summary: "Add Contact to the navigation and footer",
    draft: '<a href="/contact/">Contact</a>',
    guidance: ["Use the word 'Contact' so visitors recognize it instantly."],
  }),
  "conversion.value_prop.unclear": (page) => ({
    summary: "Rewrite the main headline as a value proposition",
    guidance: [
      `Current headline: "${page.h1s[0] ?? "none"}".`,
      "Formula: [What you do] for [who] in [where/how], with [main benefit]. Example: 'Emergency plumbing in Austin, at your door in 60 minutes'.",
      "Ask the user for their audience, location and strongest differentiator before writing it.",
    ],
  }),
  "geo.entity.organization_schema_missing": (page) => organizationDraft(page, "Organization"),
  "schema.organization.missing": (page) => organizationDraft(page, "Organization"),
  "gbp.site.localbusiness_schema_missing": (page) => organizationDraft(page, "LocalBusiness"),
  "aeo.answers.not_direct": (page) => ({
    summary: "Lead each answer with a direct 1-2 sentence answer",
    guidance: [
      ...page.questions
        .filter((q) => q.firstAnswerWords === 0 || q.firstAnswerWords > 90)
        .slice(0, 6)
        .map((q) => `Question "${q.question}": open with a 40-60 word direct answer, then keep the detail below it.`),
    ],
  }),
  "aeo.questions.none": (page) => ({
    summary: "Add a questions-and-answers section",
    draft: ["<h2>Frequently asked questions</h2>", "<h3>TODO question 1?</h3>", "<p>Direct 40-60 word answer.</p>"].join("\n"),
    guidance: [
      `Use real customer questions about ${page.h1s[0] ?? "this topic"} (ask the user, or pull question queries from Search Console).`,
      "Answer each directly first, then add supporting detail.",
    ],
  }),
  "aeo.questions.uncovered": () => ({
    summary: "Answer the uncovered customer questions",
    guidance: ["Add each question as an H2/H3 with a direct answer below it. Claude can draft the answers from facts the user confirms."],
  }),
  "gbp.site.nap_inconsistent": (page) => ({
    summary: "Standardize the phone number",
    guidance: [
      `Numbers found: ${[...new Set([...page.phonesInText, ...page.telLinks].map(digitsOnly))].join(", ")}.`,
      "Keep one primary number (the one on your Google Business Profile) in the header, footer and contact page.",
    ],
  }),
};

export function draftFor(code: string, page: PageData, recommendation: string): Draft {
  const drafter = DRAFTERS[code];
  if (drafter) return drafter(page);
  return {
    summary: recommendation,
    guidance: [
      "No automatic draft exists for this issue type. Draft the change from the recommendation and the page content, and show it to the user before anything is published.",
    ],
  };
}
