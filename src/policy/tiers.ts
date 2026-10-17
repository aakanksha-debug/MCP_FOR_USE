import type { FixPolicy, Impact, Tier } from "@/core/types";

export interface TierDefinition {
  tier: Tier;
  emoji: string;
  label: string;
  policy: FixPolicy;
  description: string;
}

/**
 * The three-tier change policy. This is the single source of truth for what
 * the MCP may do with an issue; fix tools enforce it server-side.
 */
export const TIERS: Record<Tier, TierDefinition> = {
  safe: {
    tier: "safe",
    emoji: "🟢",
    label: "Minor",
    policy: "auto-fix",
    description:
      "Content-level fixes (titles, meta descriptions, image alt text, links). Prepared only when the user asks, and published only after the site owner approves them on the approval page.",
  },
  medium: {
    tier: "medium",
    emoji: "🟡",
    label: "Medium",
    policy: "needs-approval",
    description:
      "Content and conversion recommendations. A draft is prepared only after the user explicitly approves it.",
  },
  high: {
    tier: "high",
    emoji: "🔴",
    label: "Needs expert advice",
    policy: "expert-review",
    description:
      "High-risk changes (indexing, canonicals, redirects) or anything that needs installing or removing plugins, adding code snippets, changing the theme or server settings. Never changed by the MCP; contact an Incrementors SEO strategist.",
  },
};

export const TIER_ORDER: Tier[] = ["high", "medium", "safe"];

export const IMPACT_WEIGHT: Record<Impact, number> = { high: 3, medium: 2, low: 1 };

/** Score penalty per unique issue code, by impact. */
export const IMPACT_PENALTY: Record<Impact, number> = { high: 14, medium: 7, low: 3 };
