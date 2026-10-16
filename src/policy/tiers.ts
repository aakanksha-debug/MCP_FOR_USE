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
    label: "Minor / safe",
    policy: "auto-fix",
    description:
      "Predefined low-risk issues. The MCP prepares an exact, ready-to-apply fix (additive or mechanical changes only).",
  },
  medium: {
    tier: "medium",
    emoji: "🟡",
    label: "Medium",
    policy: "needs-approval",
    description:
      "Recommendations first. A draft change is prepared only after the user explicitly approves it.",
  },
  high: {
    tier: "high",
    emoji: "🔴",
    label: "Major / high-risk",
    policy: "expert-review",
    description:
      "Never changed automatically (indexation, canonicals, redirects, architecture, complex technical work). Recommend expert review.",
  },
};

export const TIER_ORDER: Tier[] = ["high", "medium", "safe"];

export const IMPACT_WEIGHT: Record<Impact, number> = { high: 3, medium: 2, low: 1 };

/** Score penalty per unique issue code, by impact. */
export const IMPACT_PENALTY: Record<Impact, number> = { high: 14, medium: 7, low: 3 };
