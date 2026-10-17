import type { Fetcher } from "@/core/http";
import { loadSiteByKey } from "@/platforms/connections";
import { PlatformError } from "@/platforms/types";
import { randomToken } from "@/integrations/storage/crypto";
import { getApproval, saveApproval, type ApprovalRecord, type StagedChange } from "./records";

/**
 * Publishing happens only here, triggered by the site owner on the approval
 * page. Changes for the same page are written together so each page gets a
 * single snapshot that "Undo" can restore.
 */

async function load(id: string): Promise<ApprovalRecord> {
  const record = await getApproval(id);
  if (!record) throw new PlatformError("This approval link is invalid or has expired.");
  return record;
}

const targetKey = (change: StagedChange) => JSON.stringify([change.target.kind, change.target.id]);

export async function publishChanges(id: string, changeIds: string[], fetcher?: Fetcher): Promise<{ published: number; failed: number }> {
  const record = await load(id);
  if (Date.now() > record.expiresAt) throw new PlatformError("This approval link has expired. Ask Claude to prepare the fixes again.");
  const selected = record.changes.filter((change) => change.status === "pending" && changeIds.includes(change.id));
  if (!selected.length) return { published: 0, failed: 0 };

  const site = await loadSiteByKey(record.connectionKey, fetcher);
  const groups = new Map<string, StagedChange[]>();
  for (const change of selected) groups.set(targetKey(change), [...(groups.get(targetKey(change)) ?? []), change]);

  let published = 0;
  let failed = 0;
  for (const changes of groups.values()) {
    const target = changes[0]!.target;
    try {
      const snapshot = await site.adapter.applyBatch(target, changes.map((change) => change.op));
      const batchId = randomToken(9);
      record.batches.push({ id: batchId, target, changeIds: changes.map((change) => change.id), snapshot, publishedAt: Date.now() });
      for (const change of changes) {
        change.status = "published";
        change.batchId = batchId;
        delete change.error;
      }
      published += changes.length;
    } catch (error) {
      const message = error instanceof PlatformError ? error.message : "Publishing failed unexpectedly.";
      if (!(error instanceof PlatformError)) console.error("[approvals] publish failed", error);
      for (const change of changes) {
        change.status = "failed";
        change.error = message;
      }
      failed += changes.length;
    }
  }
  await saveApproval(record);
  return { published, failed };
}

export async function rejectChanges(id: string): Promise<number> {
  const record = await load(id);
  let skipped = 0;
  for (const change of record.changes) {
    if (change.status === "pending") {
      change.status = "skipped";
      skipped += 1;
    }
  }
  await saveApproval(record);
  return skipped;
}

export async function undoBatch(id: string, batchId: string, fetcher?: Fetcher): Promise<void> {
  const record = await load(id);
  const batch = record.batches.find((entry) => entry.id === batchId);
  if (!batch || batch.revertedAt) return;
  const site = await loadSiteByKey(record.connectionKey, fetcher);
  try {
    await site.adapter.revertBatch(batch.target, batch.snapshot);
    batch.revertedAt = Date.now();
    delete batch.revertError;
    for (const change of record.changes) if (change.batchId === batchId) change.status = "reverted";
  } catch (error) {
    batch.revertError = error instanceof PlatformError ? error.message : "Undo failed unexpectedly.";
    if (!(error instanceof PlatformError)) console.error("[approvals] undo failed", error);
  }
  await saveApproval(record);
}
