import type { PageData } from "@/core/extract";
import { isOkHtml, loadTarget } from "./shared";
import { emptyOutput, type AuditModule } from "./types";

export interface ConversionInput {
  url: string;
}

const GENERIC_HEADLINE = /^(home|homepage|welcome|welcome to [\w\s]+|hello|hi there|untitled|about us|main)$/i;
const CONTACT_LINK = /\b(contact|get in touch|reach us|enquir|inquir)\b/i;

function findContactPage(page: PageData): string | undefined {
  return page.links.find((link) => link.internal && (CONTACT_LINK.test(link.text) || /\/contact/i.test(link.href)))?.href;
}

export const conversionAudit: AuditModule<ConversionInput> = {
  id: "conversion",
  name: "Website Conversion Check",
  async run(ctx, input) {
    const output = emptyOutput();
    const { page } = await loadTarget(ctx, input.url);
    if (!isOkHtml(page)) {
      output.notes.push(`The page returned HTTP ${page.status}, so it could not be checked.`);
      return output;
    }
    const add = (code: string, detail?: string, evidence?: Record<string, unknown>) =>
      output.findings.push({ code, url: page.url, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) });

    // Value proposition
    const headline = page.h1s[0];
    if (!headline || GENERIC_HEADLINE.test(headline) || headline.split(/\s+/).length < 3) {
      add("conversion.value_prop.unclear", headline ? `H1 reads "${headline}"` : "No H1 headline");
    } else output.passed.push(`Headline: "${headline}"`);

    // Contact paths
    const contactUrl = findContactPage(page);
    const contactPage = contactUrl ? await ctx.page(contactUrl) : undefined;
    const pages = [page, ...(contactPage && isOkHtml(contactPage) ? [contactPage] : [])];

    if (page.phonesInText.length && page.telLinks.length === 0) {
      add("conversion.phone.not_clickable", `Phone shown as plain text: ${page.phonesInText.slice(0, 3).join(", ")}`, { phones: page.phonesInText });
    } else if (page.telLinks.length) output.passed.push("Phone number is tap-to-call");
    if (!pages.some((p) => p.phonesInText.length || p.telLinks.length)) add("conversion.phone.missing");

    const hasForm = pages.some((p) => p.forms.length > 0);
    const hasEmail = pages.some((p) => p.mailtoLinks.length > 0);
    if (!hasForm && !hasEmail) add("conversion.contact.no_form_or_email");
    else output.passed.push(hasForm ? "A contact form is available" : "An email link is available");

    if (!contactUrl) add("conversion.contact.no_contact_link");
    else output.passed.push(`Contact page linked: ${contactUrl}`);

    // Calls to action
    if (page.ctas.length === 0) add("conversion.cta.missing");
    else {
      const early = page.ctas.filter((cta) => cta.inHeader || cta.position < 0.35);
      if (!early.length) add("conversion.cta.not_prominent", `First CTA "${page.ctas[0]?.text}" appears late on the page`);
      else output.passed.push(`Early call to action: "${early[0]?.text}"`);
    }

    if (!page.hasTrustSignals) add("conversion.trust.missing");
    else output.passed.push("Trust signals (reviews, testimonials or credentials) are present");

    const longForms = pages.flatMap((p) => p.forms.filter((form) => form.fieldCount > 7).map((form) => ({ page: p.url, fields: form.fieldCount })));
    if (longForms.length) add("conversion.form.too_many_fields", `Form with ${longForms[0]?.fields} fields`, { forms: longForms });

    output.facts = {
      headline,
      ctas: page.ctas.slice(0, 10).map((cta) => cta.text),
      phones: page.phonesInText,
      tapToCall: page.telLinks,
      emails: [...new Set(pages.flatMap((p) => p.mailtoLinks))],
      forms: pages.flatMap((p) => p.forms.map((form) => ({ page: p.url, fields: form.fieldCount }))),
      contactPage: contactUrl ?? null,
    };
    output.askUser.push(
      "What is the main action you want visitors to take (call, form, booking or purchase)? Connecting GA4 shows whether visitors actually complete it.",
    );
    output.notes.push("CTA placement is estimated from the HTML order, not a rendered screenshot.");
    return output;
  },
};
