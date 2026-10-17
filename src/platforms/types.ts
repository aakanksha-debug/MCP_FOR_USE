/**
 * Platform publishing layer. A platform adapter turns approved change
 * requests into edits on the client's website (CMS API), and can undo them.
 *
 * Adapters only ever make content-level edits (titles, descriptions, alt
 * text, links in page content). Plugins, themes, code snippets and server
 * settings are out of scope by policy and are never touched.
 */

export type PlatformId = "wordpress";

/** A content change the fix engine wants to make, independent of platform. */
export type ChangeRequest =
  | { kind: "seo-title"; pageUrl: string; value: string }
  | { kind: "meta-description"; pageUrl: string; value: string }
  | { kind: "image-alt"; pageUrl: string; src: string; alt: string }
  | { kind: "replace-link"; pageUrl: string; from: string; to: string }
  | { kind: "tel-link"; pageUrl: string; text: string; href: string };

/** Where an edit is written. */
export type ChangeTarget =
  | { kind: "wp-post"; type: "pages" | "posts"; id: number; link: string }
  | { kind: "wp-media"; id: number; sourceUrl: string };

/** A single, reversible operation on a target. */
export type ChangeOp =
  | { type: "set-alt-text"; value: string }
  | { type: "set-img-alt"; src: string; alt: string }
  | { type: "replace-href"; from: string; to: string }
  | { type: "wrap-tel"; text: string; href: string };

/** A change ready for the owner to approve. */
export interface PlannedChange {
  target: ChangeTarget;
  op: ChangeOp;
  /** Human-readable summary for the approval page. */
  label: string;
  before: string;
  after: string;
}

/** A request the platform cannot publish; the owner applies it by hand. */
export interface ManualStep {
  request: ChangeRequest;
  reason: string;
}

export interface PlanResult {
  planned: (PlannedChange & { request: ChangeRequest })[];
  manual: ManualStep[];
}

/** Content of a target before and after a publish, used for undo. */
export interface Snapshot {
  before: string;
  after: string;
}

export interface SiteIdentity {
  siteUrl: string;
  siteName?: string;
  user?: string;
}

export interface PlatformAdapter {
  platform: PlatformId;
  label: string;
  /** Checks the credentials and that the account may edit content. */
  verify(): Promise<SiteIdentity>;
  /** Reads current values and turns requests into concrete, reviewable changes. Writes nothing. */
  plan(requests: ChangeRequest[]): Promise<PlanResult>;
  /** Applies all ops for one target in a single write. Fails if the content changed since planning. */
  applyBatch(target: ChangeTarget, ops: ChangeOp[]): Promise<Snapshot>;
  /** Restores the snapshot's `before` if the target still holds its `after`. */
  revertBatch(target: ChangeTarget, snapshot: Snapshot): Promise<void>;
}

export class PlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformError";
  }
}
