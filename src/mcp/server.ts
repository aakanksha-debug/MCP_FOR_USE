import type { McpServer } from "@modelcontextprotocol/server";
import { registerAuditTools } from "./tools/audit-tools";
import { registerDecisionTools } from "./tools/decision-tools";
import { registerGoogleTools } from "./tools/google-tools";
import { registerPublishTools } from "./tools/publish-tools";

export const SERVER_INFO = { name: "incrementors-audit-mcp", version: "0.1.0" } as const;

/** Registers every tool. New tool groups are added here. */
export function registerTools(server: McpServer): void {
  registerAuditTools(server);
  registerGoogleTools(server);
  registerDecisionTools(server);
  registerPublishTools(server);
}
