import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getApproval } from "@/approvals/records";
import { createSiteConnection, disconnectSite, siteConnectionStatus } from "@/platforms/connections";
import { failure, guard, text } from "../respond";
import { urlField } from "../schemas";

const siteConnectionIdField = z.string().min(10).max(200).describe("Website connection ID from connect_website (treat it like a password)");

export function registerPublishTools(server: McpServer): void {
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
      return text(
        [
          `## Approval for ${record.host}`,
          `Pending ${counts.pending ?? 0} · Published ${counts.published ?? 0} · Rejected ${counts.skipped ?? 0} · Failed ${counts.failed ?? 0} · Undone ${counts.reverted ?? 0}`,
          "",
          ...record.changes.map((change) => `- ${change.label}: ${change.status}${change.error ? ` (${change.error})` : ""}`),
        ].join("\n"),
      );
    }),
  );
}
