import { expertAdviceBlock } from "@/funnel/stages";
import type { DetectedPlatform } from "@/core/platform-detect";
import type { Issue } from "@/core/types";

/**
 * Answers "can you make these changes?" with a concrete plan: how to connect
 * for this platform, what can be fixed once connected, what facts are needed
 * from the user first, and what needs an expert.
 */

export interface FixPlan {
  host: string;
  platform: DetectedPlatform;
  connect: string[];
  fixableOnceConnected: string[];
  needFromYou: string[];
  needsApproval: string[];
  expert: { title: string; reason: string }[];
}

/** Facts only the business can give; asked for instead of invented. */
const FACTS_NEEDED: { codes: RegExp; ask: string }[] = [
  { codes: /^(aeo\.questions\.(none|uncovered)|content\.gsc\.question_queries)$/, ask: "3 to 6 real questions customers ask, for the FAQ or answer sections" },
  { codes: /^(seo\.content\.thin|content\.pages\.thin)$/, ask: "Facts for the thin pages: what you offer, pricing, process and real results, so nothing gets made up" },
  { codes: /^(conversion\.phone\.missing|gbp\.site\.phone_missing)$/, ask: "Your phone number, if you want it shown on the site" },
  { codes: /^gbp\.site\.address_missing$/, ask: "Your business address, or confirmation that you only serve customers at their location" },
  { codes: /^(conversion\.value_prop\.unclear|geo\.content\.summary_unclear)$/, ask: "Who you serve, where, and what makes you different, for the headline and opening line" },
  { codes: /^conversion\.trust\.missing$/, ask: "Real reviews, testimonials, client logos or certifications you can show" },
  { codes: /^conversion\.(cta\.missing|cta\.not_prominent)$/, ask: "The main action you want visitors to take (call, form, booking or purchase)" },
  { codes: /^geo\.content\.author_missing$/, ask: "The author's name and a one-line bio" },
  { codes: /^geo\.content\.no_evidence$/, ask: "Real numbers, results or sources you are happy to cite" },
  { codes: /^content\.key_page\.missing$/, ask: "Content for the missing pages (for example About, case studies or FAQ)" },
  { codes: /^gbp\.profile\./, ask: "Your Google Business Profile details (name, categories, reviews, photos, posts)" },
];

function connectSteps(platform: DetectedPlatform): string[] {
  switch (platform.id) {
    case "wordpress":
      return [
        "Connect the site with `connect_website`: the owner opens a secure one-time page, gives consent and adds a WordPress application password (Users → Profile → Application Passwords). Never paste passwords into the chat.",
        "Then `prepare_fixes` stages the fixes on an approval page; nothing goes live until the owner clicks Approve & publish, and every change can be undone.",
      ];
    case "shopify":
    case "wix":
    case "squarespace":
    case "webflow":
    case "framer":
    case "hubspot":
    case "ghost":
    case "drupal":
    case "joomla":
    case "godaddy":
      return [
        `One-click publishing isn't available for ${platform.name} yet. \`prepare_fixes\` gives exact, copy-ready changes with the steps for ${platform.name}, so you or your web person can paste them in a few minutes.`,
        "If you'd prefer, share the site's editor access with your developer rather than pasting passwords or tokens into this chat.",
      ];
    case "lovable":
      return [
        "The site is a Lovable (React) app, so the fixes go into its code. Paste the prepared fixes into the Lovable project as a change request, or connect the project's GitHub repository in Claude Code so they can be applied as code changes.",
        "Never paste passwords or tokens into this chat.",
      ];
    case "nextjs":
    case "nuxt":
    case "gatsby":
    case "react":
      return [
        `The site is custom code (${platform.name}), so the fixes go into its repository. Connect the GitHub repository in Claude Code, or hand the prepared fixes to your developer.`,
        "Never paste passwords or tokens into this chat.",
      ];
    default:
      return [
        "Tell me which CMS or builder the site uses. That decides how I connect: WordPress can be connected for approve-then-publish fixes; other builders get copy-ready fixes; code-based sites get the fixes as code changes through the GitHub repository.",
        "Never paste passwords or tokens into this chat.",
      ];
  }
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

export function buildFixPlan(host: string, platform: DetectedPlatform, issues: Issue[]): FixPlan {
  const needFromYou: string[] = [];
  const needsApproval: string[] = [];
  for (const issue of issues.filter((item) => item.tier === "medium")) {
    const fact = FACTS_NEEDED.find((entry) => entry.codes.test(issue.code));
    if (fact) needFromYou.push(fact.ask);
    else needsApproval.push(issue.title);
  }
  return {
    host,
    platform,
    connect: connectSteps(platform),
    fixableOnceConnected: unique(issues.filter((issue) => issue.tier === "safe").map((issue) => issue.title)),
    needFromYou: unique(needFromYou),
    needsApproval: unique(needsApproval),
    expert: unique(issues.filter((issue) => issue.tier === "high").map((issue) => issue.title)).map((title) => ({
      title,
      reason: issues.find((issue) => issue.title === title)?.expertReason ?? "High-risk change",
    })),
  };
}

export function formatFixPlan(plan: FixPlan): string {
  const fixableCount = plan.fixableOnceConnected.length + plan.needFromYou.length + plan.needsApproval.length;
  const opener =
    fixableCount === 0
      ? "The remaining issues need expert work, so I won't change them myself."
      : plan.expert.length > fixableCount
        ? "Yes, for some of them. The rest need an expert."
        : "Yes, for most of them.";
  const section = (title: string, items: string[]) => (items.length ? [``, `**${title}**`, ...items.map((item) => `- ${item}`)] : []);
  return [
    `## Applying fixes to ${plan.host}`,
    `${opener} The site runs on **${plan.platform.name}**, which decides how the changes get applied.`,
    ...section("How to give access", plan.connect),
    ...section("What I can fix once connected (you approve before anything goes live)", plan.fixableOnceConnected),
    ...section("What I need from you first", plan.needFromYou),
    ...section("Recommended changes I'll draft after you approve them", plan.needsApproval),
  ].join("\n") + expertAdviceBlock(plan.expert.map((item) => ({ title: item.title, reason: item.reason })));
}
