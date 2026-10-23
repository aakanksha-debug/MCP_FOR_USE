import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getApproval } from "@/approvals/records";
import { nextAfterFixes } from "@/funnel/stages";
import { loadTarget } from "@/audits/shared";
import { createAuditContext } from "@/core/context";
import { buildFixPlan, formatFixPlan } from "@/fixes/application-plan";
import { classify } from "@/policy/classify";
import { getIssueDefinition } from "@/policy/catalog";
import { createSiteConnection, disconnectSite, siteConnectionStatus } from "@/platforms/connections";
import { failure, guard, text } from "../respond";
import { issueRefField, urlField } from "../schemas";

const siteConnectionIdField = z.string().min(10).max(200).describe("Website connection ID from connect_website (treat it like a password)");

export function registerPublishTools(server: McpServer): void {
  server.registerTool(
    "get_fix_plan",
    {
      title: "Plan how to apply the fixes",
      description:
        "CALL THIS WHEN THE USER ASKS YOU TO MAKE, APPLY OR PUBLISH CHANGES to their website. Detects the site's platform (WordPress, Shopify, Wix, Webflow, Squarespace, Lovable, Next.js and others) and returns how to give access for that platform, which issues can be fixed once connected, what facts are needed from the user first, and which need an expert. Pass the issues from the audit results.",
      inputSchema: z.object({
        url: urlField,
        issues: z.array(issueRefField).max(60).optional().describe("Issues from audit results (code and url)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ url, issues }) => {
      const { page } = await loadTarget(createAuditContext({ budgetMs: 20_000 }), url);
      const known = (issues ?? []).filter((issue) => getIssueDefinition(issue.code));
      const plan = buildFixPlan(new URL(page.url).hostname, page.platform ?? { id: "unknown", name: "Unknown", kind: "unknown" }, classify(known));
      return text(formatFixPlan(plan));
    }),
  );

  server.registerTool(
    "connect_website",
    {
      title: "Connect a website for publishing approved fixes",
      description:
        "ASK THE USER FOR PERMISSION BEFORE CALLING. Creates a secure, one-time page where the site owner connects their website (WordPress supported) so minor SEO fixes they approve can be published. The owner enters credentials on that page, never in the chat, and must give consent. Returns the link and a siteConnectionId for prepare_fixes.",
      inputSchema: z.object({ url: urlField }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(async ({ url }) => {
      const connection = await createSiteConnection(url);
      return text(
        [
          `## Connect ${connection.host}`,
          `1. Ask the site owner to open this link: ${connection.connectUrl}`,
          "2. They confirm consent and enter their WordPress username and an application password there (never in this chat).",
          `3. The link works once and expires in ${connection.expiresInMinutes} minutes.`,
          "4. When they say they are done, call website_connection_status, then prepare_fixes with the siteConnectionId below.",
          "",
          `siteConnectionId: \`${connection.connectionId}\``,
          "",
          "Even when connected, nothing is published until the owner approves each change on the approval page. Plugins, themes, code snippets and settings are never touched.",
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "website_connection_status",
    {
      title: "Website connection status",
      description: "Checks whether the site owner finished connecting their website for a siteConnectionId.",
      inputSchema: z.object({ siteConnectionId: siteConnectionIdField }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ siteConnectionId }) => {
      const status = await siteConnectionStatus(siteConnectionId);
      if (status.status === "not_found") return text("No connection found for this ID (it may have expired). Run connect_website again.");
      if (status.status === "pending") return text(`The owner has not finished connecting ${status.host} yet.`);
      return text(
        `Connected: ${status.siteName ?? status.host} (${status.platform})${status.user ? ` as ${status.user}` : ""} since ${status.connectedAt}.`,
      );
    }),
  );

  server.registerTool(
    "disconnect_website",
    {
      title: "Disconnect website",
      description: "Deletes the stored website credentials for a siteConnectionId.",
      inputSchema: z.object({ siteConnectionId: siteConnectionIdField }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    guard(async ({ siteConnectionId }) => {
      const removed = await disconnectSite(siteConnectionId);
      return text(
        removed
          ? "The website was disconnected and its stored credentials deleted. For full peace of mind, the owner can also revoke the application password in WordPress (Users → Profile → Application Passwords)."
          : "No connection was found for this ID.",
      );
    }),
  );

  server.registerTool(
    "fix_approval_status",
    {
      title: "Fix approval status",
      description: "Shows which staged fixes the site owner approved and published, rejected or undid.",
      inputSchema: z.object({ approvalId: z.string().min(20).max(64).describe("approvalId returned by prepare_fixes") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ approvalId }) => {
      const record = await getApproval(approvalId);
      if (!record) return failure("Approval not found or expired.");
      const counts = record.changes.reduce<Record<string, number>>((acc, change) => ({ ...acc, [change.status]: (acc[change.status] ?? 0) + 1 }), {});
      const published = record.changes.filter((change) => change.status === "published");
      const others = record.changes.filter((change) => change.status !== "published");
      return text(
        [
          `## Fixes for ${record.host}`,
          `Published ${counts.published ?? 0} · Waiting ${counts.pending ?? 0} · Rejected ${counts.skipped ?? 0} · Failed ${counts.failed ?? 0} · Undone ${counts.reverted ?? 0}`,
          ...(published.length
            ? [
                "",
                `**✅ ${published.length} thing${published.length === 1 ? "" : "s"} we fixed (live now, before → after)**`,
                ...published.map((change) => `- ${change.label}: "${change.before}" → "${change.after}"`),
                "",
                "_For the final report, add the audit's other report-card lines: the things we recommend, the growth opportunity and the major issues requiring expert advice._",
              ]
            : []),
          ...(others.length ? ["", "**Other changes**", ...others.map((change) => `- ${change.label}: ${change.status}${change.error ? ` (${change.error})` : ""}`)] : []),
        ].join("\n") + (counts.pending ? "" : nextAfterFixes(false)),
      );
    }),
  );
}
