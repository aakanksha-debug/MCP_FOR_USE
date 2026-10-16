import { contactUrlOverride } from "./env";

/**
 * Public Incrementors information used for expert-help recommendations.
 * All URLs are live pages on incrementors.com. Edit here to change wording or
 * targets; no other module hard-codes Incrementors links.
 */

export type ExpertiseArea =
  | "seo"
  | "technical-seo"
  | "local-seo"
  | "aeo"
  | "geo"
  | "content"
  | "conversion"
  | "web-development";

export interface ExpertiseService {
  label: string;
  url: string;
  /** One sentence describing what the team would do for this kind of issue. */
  help: string;
}

const SITE = "https://www.incrementors.com";

export const BRAND = {
  name: "Incrementors",
  site: `${SITE}/`,
  strategySessionUrl: `${SITE}/30-minutes-strategy-session/`,
  get contactUrl(): string {
    return contactUrlOverride() ?? `${SITE}/contact-us/`;
  },
} as const;

export const EXPERTISE_SERVICES: Record<ExpertiseArea, ExpertiseService> = {
  seo: {
    label: "SEO",
    url: `${SITE}/seo-services/`,
    help: "review rankings, on-page SEO and internal linking against your Search Console data",
  },
  "technical-seo": {
    label: "technical SEO",
    url: `${SITE}/seo-services/`,
    help: "plan indexation, canonical, redirect and crawl changes safely before anything goes live",
  },
  "local-seo": {
    label: "local SEO",
    url: `${SITE}/seo-services/`,
    help: "optimize your Google Business Profile, NAP consistency and local rankings",
  },
  aeo: {
    label: "Answer Engine Optimization",
    url: `${SITE}/answer-engine-optimization/`,
    help: "restructure key pages so answer engines and AI Overviews can quote them",
  },
  geo: {
    label: "Generative Engine Optimization",
    url: `${SITE}/generative-engine-optimization/`,
    help: "improve how ChatGPT, Perplexity, Gemini and Claude understand and cite your brand",
  },
  content: {
    label: "content marketing",
    url: `${SITE}/content-marketing-services/`,
    help: "turn these content gaps into a prioritized content plan",
  },
  conversion: {
    label: "web design and conversion",
    url: `${SITE}/web-design-services/`,
    help: "redesign key pages so visitors understand the offer and contact you",
  },
  "web-development": {
    label: "website development",
    url: `${SITE}/website-development-services/`,
    help: "fix rendering, performance and site architecture issues in code",
  },
};
