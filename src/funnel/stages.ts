import { BRAND } from "@/config/brand";

/**
 * The progressive funnel. Each stage gives value first, then offers the next
 * deeper level. Every tool result ends with exactly one "next step" so the
 * user always knows why to continue, and nothing is asked for up front.
 *
 *   Audit → Safe fixes (with permission) → Search Console → GA4
 *   → Data-driven audit → Critical issues → Incrementors expert (when supported)
 */

export type FunnelStage = "audit" | "fixes" | "search" | "traffic" | "deep";

export interface TierCounts {
  safe: number;
  medium: number;
  high: number;
}

const block = (title: string, lines: string[]) => `\n\n### ➡️ ${title}\n${lines.join("\n")}`;

export const SEARCH_CONSOLE_PITCH =
  "Your website audit is complete. A crawl alone can't tell how Google actually treats your site. To see which of these issues are really affecting your visibility, I can compare them with your real Search Console data (impressions, clicks, CTR, rankings, queries).";

export const ANALYTICS_PITCH =
  "Search Console shows how people find your website. Google Analytics shows what happens after they arrive: which pages keep visitors, which traffic sources work, and whether visits turn into enquiries or sales.";

/**
 * Google state for the audit's next step: true when Search Console or
 * Analytics data was used, "no_data" when the user signed in but that account
 * has no data for this site, false when Google is not connected.
 */
export type GoogleState = boolean | "no_data";

const DEEP_AUDIT_STEP = "**Continue → Deep Data-Driven Audit** to combine the website, Search Console and Analytics data and rank every issue by real business impact.";
const NO_DATA_STEP =
  "For data-backed priorities, add the Google account you signed in with as a user of this site's Search Console and Google Analytics (or reconnect the connector with the account that has them).";

/** After the Stage 1 audit: safe fixes first, then Google data. */
export function nextAfterAudit(counts: TierCounts, googleConnected: GoogleState): string {
  if (counts.safe > 0) {
    return block("Next step: safe fixes", [
      `I found **${counts.safe} issue${counts.safe === 1 ? "" : "s"} that can be safely fixed** (content-level changes like titles, descriptions, alt text and links). Would you like me to fix ${counts.safe === 1 ? "it" : "them"}?`,
      "Nothing changes without your permission, and you approve every change before it goes live.",
      "",
      googleConnected === true
        ? `Then: ${DEEP_AUDIT_STEP}`
        : googleConnected === "no_data"
          ? `Then: ${NO_DATA_STEP}`
          : `Then: **Continue → Connect Google Search Console** to see which issues actually affect your Google visibility.`,
    ]);
  }
  if (googleConnected === true) return block("Next step: deep, data-driven audit", [DEEP_AUDIT_STEP]);
  if (googleConnected === "no_data") return block("Next step: connect the right Google data", [NO_DATA_STEP]);
  return nextAfterFixes(false);
}

/** After safe fixes (or when there are none): Search Console. */
export function nextAfterFixes(googleConnected: boolean): string {
  if (googleConnected) {
    return block("Next step: search performance", ["**Continue → Search Performance Analysis** to see how Google is treating these pages."]);
  }
  return block("Next step: connect Google Search Console", [
    SEARCH_CONSOLE_PITCH,
    "",
    "**Continue → Connect Google Search Console** (read-only Google sign-in, about a minute). Say \"connect Search Console\".",
  ]);
}

/** After the Search Console analysis: GA4. */
export function nextAfterSearch(analyticsConnected: boolean): string {
  if (analyticsConnected) {
    return block("Next step: traffic and conversions", ["**Continue → Traffic & Conversion Analysis** with Google Analytics."]);
  }
  return block("Next step: connect Google Analytics", [
    ANALYTICS_PITCH,
    "",
    "**Continue → Connect Google Analytics (GA4)** (read-only, same Google sign-in). Say \"connect Analytics\".",
  ]);
}

/** After the GA4 analysis: the combined deep audit. */
export function nextAfterTraffic(): string {
  return block("Next step: deep, data-driven audit", [
    "I now have your website, Search Console and Analytics data. **Continue → Deep Data-Driven Audit** to combine all three and rank every issue by real business impact.",
  ]);
}

/**
 * Final stage. Recommends an Incrementors strategist only when the audit
 * found expert-level work; otherwise says so plainly.
 */
export function expertConversion(counts: TierCounts): string {
  const total = counts.safe + counts.medium + counts.high;
  const summary = [
    `Your audit is complete. We identified **${total} opportunit${total === 1 ? "y" : "ies"}**:`,
    `- 🟢 ${counts.safe} can be handled through safe fixes (with your approval)`,
    `- 🟡 ${counts.medium} require implementation or review`,
    `- 🔴 ${counts.high} require strategic SEO/AEO/GEO expertise`,
  ];
  if (counts.high === 0) {
    return block("Summary", [...summary, "", "Nothing here needs specialist work. You can handle these with the fixes and recommendations above."]);
  }
  return block("Recommended next step", [
    ...summary,
    "",
    "Some of these changes could affect rankings, traffic, indexing or website architecture if implemented incorrectly.",
    "",
    `**Recommended next step: Connect with an Incrementors SEO/AEO/GEO strategist.** Say "connect with an expert", or book a free 30-minute strategy session: ${BRAND.strategySessionUrl}`,
  ]);
}
