import { randomToken } from "@/integrations/storage/crypto";
import { getStore } from "@/integrations/storage/kv";
import { PlatformError, type ChangeOp, type ChangeTarget, type Snapshot } from "@/platforms/types";

/**
 * An approval is a set of prepared changes waiting for the site owner. The
 * owner reviews them on /approve/<id>; nothing is published before that.
 * Records are kept for 30 days so published changes can be undone.
 */

export const APPROVAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECORD_TTL = 30 * 24 * 60 * 60;

export type ChangeStatus = "pending" | "published" | "failed" | "skipped" | "reverted";

export interface StagedChange {
  id: string;
  issueCode: string;
  issueTitle: string;
  pageUrl: string;
  label: string;
  before: string;
  after: string;
  target: ChangeTarget;
  op: ChangeOp;
  status: ChangeStatus;
  error?: string;
  batchId?: string;
}

export interface ManualItem {
  issueTitle: string;
  pageUrl: string;
  label: string;
  text: string;
  reason: string;
}

export interface ExpertItem {
  issueTitle: string;
  pageUrl: string;
  reason: string;
  whatIsNeeded: string;
}

export interface Batch {
  id: string;
  target: ChangeTarget;
  changeIds: string[];
  snapshot: Snapshot;
  publishedAt: number;
  revertedAt?: number;
  revertError?: string;
}

export interface ApprovalRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  host: string;
  connectionKey: string;
  platformLabel: string;
  siteName?: string;
  changes: StagedChange[];
  manual: ManualItem[];
  expert: ExpertItem[];
  batches: Batch[];
}

function store() {
  const kv = getStore();
  if (!kv) throw new PlatformError("Approval storage is not configured on this server.");
  return kv;
}

const recordKey = (id: string) => `approval:${id}`;

export async function createApproval(
  input: Omit<ApprovalRecord, "id" | "createdAt" | "expiresAt" | "batches" | "changes"> & {
    changes: Omit<StagedChange, "id" | "status">[];
  },
): Promise<ApprovalRecord> {
  const now = Date.now();
  const record: ApprovalRecord = {
    ...input,
    id: randomToken(24),
    createdAt: now,
    expiresAt: now + APPROVAL_WINDOW_MS,
    changes: input.changes.map((change, index) => ({ ...change, id: `c${index + 1}`, status: "pending" })),
    batches: [],
  };
  await store().set(recordKey(record.id), record, RECORD_TTL);
  return record;
}

export async function getApproval(id: string): Promise<ApprovalRecord | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) return null;
  return store().get<ApprovalRecord>(recordKey(id));
}

export async function saveApproval(record: ApprovalRecord): Promise<void> {
  const ttl = Math.max(60, Math.round((record.createdAt + RECORD_TTL * 1000 - Date.now()) / 1000));
  await store().set(recordKey(record.id), record, ttl);
}
