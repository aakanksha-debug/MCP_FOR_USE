import type { ExpertiseArea } from "@/config/brand";

/** Change risk. Decides what the MCP may fix, never what matters most. */
export type Tier = "safe" | "medium" | "high";

/** Expected effect on visibility or conversions, used for prioritizing. */
export type Impact = "low" | "medium" | "high";

export type AuditId =
  | "seo"
  | "gbp"
  | "aeo"
  | "geo"
  | "conversion"
  | "technical"
  | "schema"
  | "content";

/** Fix generators available for safe issues (see src/fixes). */
export type FixKind =
  | "title"
  | "meta-description"
  | "alt-text"
  | "broken-link"
  | "open-graph"
  | "robots-sitemap-line"
  | "html-lang"
  | "faq-schema"
  | "llms-txt"
  | "same-as"
  | "tel-link"
  | "schema-context"
  | "website-schema"
  | "breadcrumb-schema";

/** Static definition of an issue type. Lives in the policy catalog. */
export interface IssueDefinition {
  code: string;
  category: AuditId;
  tier: Tier;
  impact: Impact;
  title: string;
  why: string;
  recommendation: string;
  expertise: ExpertiseArea;
  /** Present only on safe issues that have a fix generator. */
  fix?: FixKind;
}

/** What an audit observed. Audits emit findings; the policy layer classifies them. */
export interface Finding {
  code: string;
  url: string;
  detail?: string;
  evidence?: Record<string, unknown>;
}

export type FixPolicy = "auto-fix" | "needs-approval" | "expert-review";

/** A finding enriched with its catalog definition. */
export interface Issue extends Finding {
  category: AuditId;
  tier: Tier;
  impact: Impact;
  title: string;
  why: string;
  recommendation: string;
  expertise: ExpertiseArea;
  fixPolicy: FixPolicy;
  fix?: FixKind;
}

export interface AuditResult {
  audit: AuditId;
  name: string;
  target: string;
  checkedAt: string;
  /** 0-100 heuristic health score for this audit only. */
  score: number;
  issues: Issue[];
  /** Checks that passed, kept short so users see what is already right. */
  passed: string[];
  /** Extracted facts other tools or Claude can reuse. */
  facts: Record<string, unknown>;
  /** Limits of this run (pages skipped, heuristics, data not available). */
  notes: string[];
  /** Information Claude should ask the user for to improve accuracy. */
  askUser: string[];
}
