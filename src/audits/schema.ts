import type { PageData } from "@/core/extract";
import type { Finding } from "@/core/types";
import { digitsOnly, isHomepage, isNoindex, isNotForSearch, isOkHtml, loadPages, loadTarget, pickSamplePages } from "./shared";
import { emptyOutput, type AuditModule } from "./types";

export interface SchemaInput {
  url: string;
  /** Pages to check including the start page (1-10). */
  maxPages?: number;
}

type Node = Record<string, unknown>;

interface TypeRule {
  required: string[][];
  recommended: string[][];
}

/**
 * Property rules per type. Each inner array is a set of alternatives: one of
 * them must be present. Based on Google's structured data documentation.
 */
const RULES: Record<string, TypeRule> = {
  Organization: { required: [["name"], ["url"]], recommended: [["logo"], ["sameAs"], ["contactPoint", "telephone", "email"]] },
  LocalBusiness: {
    required: [["name"], ["address"]],
    recommended: [["telephone"], ["url"], ["openingHoursSpecification", "openingHours"], ["geo"], ["image"], ["priceRange"]],
  },
  WebSite: { required: [["name"], ["url"]], recommended: [] },
  Article: { required: [["headline", "name"]], recommended: [["author"], ["datePublished"], ["dateModified"], ["image"], ["publisher"]] },
  Product: {
    required: [["name"], ["offers", "review", "aggregateRating"]],
    recommended: [["image"], ["description"], ["brand"], ["sku", "gtin", "gtin13", "mpn"]],
  },
  Offer: { required: [["price", "priceSpecification", "lowPrice"], ["priceCurrency", "priceSpecification"]], recommended: [["availability"]] },
  FAQPage: { required: [["mainEntity"]], recommended: [] },
  BreadcrumbList: { required: [["itemListElement"]], recommended: [] },
  Event: { required: [["name"], ["startDate"], ["location"]], recommended: [["endDate"], ["image"], ["description"], ["offers"]] },
  VideoObject: { required: [["name"], ["thumbnailUrl"], ["uploadDate"]], recommended: [["description"], ["contentUrl", "embedUrl"]] },
  AggregateRating: { required: [["ratingValue"], ["ratingCount", "reviewCount"]], recommended: [] },
  Review: { required: [["reviewRating"], ["author"]], recommended: [["itemReviewed"]] },
  Service: { required: [["name", "serviceType"]], recommended: [["provider"], ["areaServed"], ["description"]] },
  Recipe: { required: [["name"], ["image"]], recommended: [["recipeIngredient"], ["recipeInstructions"]] },
  JobPosting: { required: [["title"], ["description"], ["datePosted"], ["hiringOrganization"]], recommended: [["jobLocation", "applicantLocationRequirements"], ["validThrough"]] },
};

const ARTICLE_TYPES = new Set(["Article", "BlogPosting", "NewsArticle", "TechArticle", "Report"]);
const ORGANIZATION_TYPES = new Set(["Organization", "Corporation", "NGO", "EducationalOrganization", "OnlineBusiness", "OnlineStore"]);

/** Common schema.org LocalBusiness subtypes. */
export const LOCAL_BUSINESS_TYPES = new Set(
  (
    "LocalBusiness ProfessionalService Dentist Physician MedicalBusiness MedicalClinic MedicalOrganization LegalService Attorney Notary " +
    "Restaurant FoodEstablishment CafeOrCoffeeShop Bakery BarOrPub Store AutoRepair AutomotiveBusiness AutoDealer " +
    "HomeAndConstructionBusiness Plumber Electrician RoofingContractor HVACBusiness GeneralContractor HousePainter Locksmith " +
    "MovingCompany RealEstateAgent FinancialService AccountingService InsuranceAgency HealthAndBeautyBusiness BeautySalon DaySpa " +
    "HairSalon NailSalon ExerciseGym SportsActivityLocation LodgingBusiness Hotel ChildCare Preschool VeterinaryCare Optician " +
    "Pharmacy EmploymentAgency TravelAgency DryCleaningOrLaundry EntertainmentBusiness EmergencyService"
  ).split(" "),
);

function typesOf(node: Node): string[] {
  const type = node["@type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

function ruleFor(types: string[]): { name: string; rule: TypeRule } | undefined {
  for (const type of types) {
    if (RULES[type]) return { name: type, rule: RULES[type]! };
    if (ARTICLE_TYPES.has(type)) return { name: type, rule: RULES.Article! };
    if (LOCAL_BUSINESS_TYPES.has(type)) return { name: type, rule: RULES.LocalBusiness! };
    if (ORGANIZATION_TYPES.has(type)) return { name: type, rule: RULES.Organization! };
  }
  return undefined;
}

function hasValue(node: Node, key: string): boolean {
  const value = node[key];
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Top-level nodes: each JSON-LD object or array item, plus @graph members. */
export function topLevelNodes(data: unknown): Node[] {
  const nodes: Node[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const node = value as Node;
      if (Array.isArray(node["@graph"])) (node["@graph"] as unknown[]).forEach(visit);
      if (typesOf(node).length) nodes.push(node);
    }
  };
  visit(data);
  return nodes;
}

function collectPhones(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => collectPhones(item, into));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Node)) {
      if (key === "telephone" && typeof child === "string") into.push(child);
      else if (child && typeof child === "object") collectPhones(child, into);
    }
  }
  return into;
}

function looksLikeArticle(page: PageData): boolean {
  return /\/(blog|news|article|articles|insights|guides?|resources|posts?)\//i.test(page.url) && page.wordCount > 300 && Boolean(page.datePublished || page.author);
}

function looksLikeProduct(page: PageData): boolean {
  const priced = /(?:[$€£₹]\s?\d|\d\s?(?:usd|eur|gbp|inr))/i.test(page.text);
  const buyable = page.ctas.some((cta) => /add to (cart|bag|basket)|buy now/i.test(cta.text));
  return priced && (buyable || /\/products?\//i.test(new URL(page.url).pathname));
}

export function pageSchemaFindings(page: PageData): { findings: Finding[]; types: string[] } {
  const findings: Finding[] = [];
  const add = (code: string, detail?: string, evidence?: Record<string, unknown>) =>
    findings.push({ code, url: page.url, ...(detail ? { detail } : {}), ...(evidence ? { evidence } : {}) });

  if (page.jsonLd.length === 0 && page.microdataTypes.length === 0 && !isNoindex(page) && !isNotForSearch(page.url)) add("schema.none");

  const invalid = page.jsonLd.filter((block) => block.error);
  if (invalid.length) add("schema.jsonld.invalid", invalid.map((block) => block.error).join("; "), { snippets: invalid.map((block) => block.raw.slice(0, 200)) });

  const missingContext = page.jsonLd.filter((block) => {
    if (!block.data) return false;
    const roots = Array.isArray(block.data) ? block.data : [block.data];
    return roots.some((root) => root && typeof root === "object" && !("@context" in (root as Node)));
  });
  if (missingContext.length) add("schema.jsonld.missing_context", `${missingContext.length} JSON-LD block(s)`);

  const nodes = page.jsonLd.flatMap((block) => (block.data ? topLevelNodes(block.data) : []));
  const missingRequired: string[] = [];
  const missingRecommended: string[] = [];
  for (const node of nodes) {
    const match = ruleFor(typesOf(node));
    if (!match) continue;
    const required = match.rule.required.filter((options) => !options.some((key) => hasValue(node, key)));
    const recommended = match.rule.recommended.filter((options) => !options.some((key) => hasValue(node, key)));
    if (required.length) missingRequired.push(`${match.name}: ${required.map((options) => options.join(" or ")).join(", ")}`);
    if (recommended.length) missingRecommended.push(`${match.name}: ${recommended.map((options) => options.join(" or ")).join(", ")}`);
    if (typesOf(node).includes("Product")) {
      const offers = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : [];
      for (const offer of offers as Node[]) {
        const offerRequired = RULES.Offer!.required.filter((options) => !options.some((key) => hasValue(offer, key)));
        if (offerRequired.length) missingRequired.push(`Offer: ${offerRequired.map((options) => options.join(" or ")).join(", ")}`);
      }
    }
  }
  if (missingRequired.length) add("schema.required_property_missing", missingRequired.join("; "), { missing: missingRequired });
  if (missingRecommended.length) add("schema.recommended_property_missing", missingRecommended.join("; "), { missing: missingRecommended });

  const types = new Set(page.schemaTypes);
  const hasOrganization = [...types].some((type) => ORGANIZATION_TYPES.has(type) || LOCAL_BUSINESS_TYPES.has(type));
  if (isHomepage(page.url)) {
    if (!hasOrganization) add("schema.organization.missing");
    if (!types.has("WebSite")) add("schema.website.missing");
  }
  if (page.breadcrumb.length >= 2 && !types.has("BreadcrumbList")) {
    add("schema.breadcrumb.missing", page.breadcrumb.map((item) => item.name).join(" › "));
  }
  if (looksLikeArticle(page) && ![...types].some((type) => ARTICLE_TYPES.has(type))) add("schema.article.missing");
  if (looksLikeProduct(page) && !types.has("Product")) add("schema.product.missing");

  const answered = page.questions.filter((q) => q.answerWords >= 5);
  if (answered.length >= 2 && !types.has("FAQPage")) {
    add("aeo.faq_schema.missing", `${answered.length} visible question/answer pairs`);
  }

  const visibleDigits = new Set([...page.phonesInText, ...page.telLinks].map(digitsOnly));
  const schemaPhones = page.jsonLd.flatMap((block) => (block.data ? collectPhones(block.data) : []));
  const unseen = schemaPhones.filter((phone) => !visibleDigits.has(digitsOnly(phone)));
  if (unseen.length && visibleDigits.size > 0) add("schema.phone_mismatch", `Markup phone ${unseen.join(", ")} is not shown on the page`);

  return { findings, types: [...types] };
}

export const schemaAudit: AuditModule<SchemaInput> = {
  id: "schema",
  name: "Schema Check",
  async run(ctx, input) {
    const output = emptyOutput();
    const { page: home } = await loadTarget(ctx, input.url);
    const maxPages = Math.min(Math.max(input.maxPages ?? 3, 1), 10);
    const pages = [home, ...(await loadPages(ctx, await pickSamplePages(ctx, home, maxPages - 1)))].filter(isOkHtml);

    const typesByPage: Record<string, string[]> = {};
    for (const page of pages) {
      const { findings, types } = pageSchemaFindings(page);
      output.findings.push(...findings);
      typesByPage[page.url] = types;
    }
    const allTypes = new Set(Object.values(typesByPage).flat());
    if (allTypes.size) output.passed.push(`Structured data found: ${[...allTypes].slice(0, 12).join(", ")}`);
    if (!output.findings.some((finding) => finding.code === "schema.jsonld.invalid")) output.passed.push("All JSON-LD blocks parse as valid JSON");

    output.facts = { typesByPage };
    output.notes.push(
      "This is a structural check. Validate final markup with Google's Rich Results Test and the Schema.org validator before publishing.",
    );
    return output;
  },
};
