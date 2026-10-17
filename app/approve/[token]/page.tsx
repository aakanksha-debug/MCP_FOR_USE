import type { Metadata } from "next";
import { getApproval, type ApprovalRecord, type StagedChange } from "@/approvals/records";
import { BRAND } from "@/config/brand";
import { PlatformError } from "@/platforms/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Review SEO fixes | Incrementors Website Audit",
  robots: { index: false, follow: false },
};

const STATUS_LABEL: Record<StagedChange["status"], string> = {
  pending: "Waiting for approval",
  published: "Published",
  failed: "Not published",
  skipped: "Rejected",
  reverted: "Undone",
};

function Diff({ change }: { change: StagedChange }) {
  return (
    <dl className="diff">
      <dt>Before</dt>
      <dd>{change.before}</dd>
      <dt>After</dt>
      <dd>{change.after}</dd>
    </dl>
  );
}

function PendingForm({ record, token }: { record: ApprovalRecord; token: string }) {
  const pending = record.changes.filter((change) => change.status === "pending");
  if (!pending.length) return null;
  const expired = Date.now() > record.expiresAt;
  return (
    <form method="post" action={`/api/approvals/${token}`} className="card">
      <h2 style={{ marginTop: 0 }}>Waiting for your approval ({pending.length})</h2>
      <p>Untick anything you don&apos;t want. Nothing below is live yet.</p>
      {pending.map((change) => (
        <div className="change" key={change.id}>
          <label className="check">
            <input type="checkbox" name="change" value={change.id} defaultChecked disabled={expired} />
            <span>
              <strong>{change.label}</strong>
              <br />
              <small>
                {change.issueTitle} · {change.pageUrl}
              </small>
            </span>
          </label>
          <Diff change={change} />
        </div>
      ))}
      {expired ? (
        <div className="alert warn">
          <p>This approval link has expired. Ask Claude to prepare the fixes again.</p>
        </div>
      ) : (
        <div className="actions">
          <button className="button" type="submit" name="action" value="publish">
            Approve &amp; publish selected
          </button>
          <button className="button secondary" type="submit" name="action" value="reject" formNoValidate>
            Reject all
          </button>
        </div>
      )}
    </form>
  );
}

function History({ record, token }: { record: ApprovalRecord; token: string }) {
  const done = record.changes.filter((change) => change.status !== "pending");
  if (!done.length) return null;
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Results</h2>
      {done.map((change) => {
        const batch = record.batches.find((entry) => entry.id === change.batchId);
        return (
          <div className="change" key={change.id}>
            <strong>{change.label}</strong> <span className={`status ${change.status}`}>{STATUS_LABEL[change.status]}</span>
            <br />
            <small>{change.pageUrl}</small>
            <Diff change={change} />
            {change.error ? <p className="status failed">{change.error}</p> : null}
            {batch?.revertError ? <p className="status failed">{batch.revertError}</p> : null}
          </div>
        );
      })}
      {record.batches
        .filter((batch) => !batch.revertedAt)
        .map((batch) => {
          const labels = record.changes.filter((change) => batch.changeIds.includes(change.id)).map((change) => change.label);
          return (
            <form method="post" action={`/api/approvals/${token}`} key={batch.id} className="actions">
              <input type="hidden" name="batch" value={batch.id} />
              <button className="button secondary small" type="submit" name="action" value="undo">
                Undo: {labels.length === 1 ? labels[0] : `${labels.length} changes on ${record.changes.find((c) => c.batchId === batch.id)?.pageUrl}`}
              </button>
            </form>
          );
        })}
    </div>
  );
}

export default async function ApprovalPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const { token } = await params;
  const { notice } = await searchParams;

  let record: ApprovalRecord | null = null;
  try {
    record = await getApproval(token);
  } catch (error) {
    return (
      <main>
        <h1>Approvals unavailable</h1>
        <p>{error instanceof PlatformError ? error.message : "Something went wrong. Please try again later."}</p>
      </main>
    );
  }
  if (!record) {
    return (
      <main>
        <h1>Approval not found</h1>
        <p>This link is invalid or has expired. Ask Claude to prepare the fixes again.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Review SEO fixes for {record.siteName ?? record.host}</h1>
      <p>
        Prepared by Incrementors Website Audit for {record.host} ({record.platformLabel}). Changes go live only when you click
        Approve, and you can undo published changes from this page for 30 days.
      </p>

      {notice ? (
        <div className="alert ok">
          <p>{notice}</p>
        </div>
      ) : null}

      <PendingForm record={record} token={token} />
      <History record={record} token={token} />

      {record.manual.length ? (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Do these yourself ({record.manual.length})</h2>
          <p>These can&apos;t be published automatically on your platform. Copy the suggested text into your site.</p>
          {record.manual.map((item, index) => (
            <div className="change" key={index}>
              <strong>{item.issueTitle}</strong>
              <br />
              <small>{item.pageUrl}</small>
              <dl className="diff">
                <dt>Use</dt>
                <dd>{item.text}</dd>
                <dt>Why</dt>
                <dd>{item.reason}</dd>
              </dl>
            </div>
          ))}
        </div>
      ) : null}

      {record.expert.length ? (
        <div className="alert warn">
          <h2>⚠️ Needs expert advice ({record.expert.length})</h2>
          <p>
            These were <strong>not changed</strong>. They are high-risk, or need plugins installed or removed, code snippets,
            theme changes or server settings. Done wrong, they can break the site or hurt rankings.
          </p>
          <ul>
            {record.expert.map((item, index) => (
              <li key={index}>
                <strong>{item.issueTitle}</strong> ({item.pageUrl}): {item.whatIsNeeded}
              </li>
            ))}
          </ul>
          <p>
            <a className="button" href={BRAND.strategySessionUrl}>
              Talk to an {BRAND.strategistLabel}
            </a>
          </p>
        </div>
      ) : null}
    </main>
  );
}
