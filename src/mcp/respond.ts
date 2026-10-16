import type { CallToolResult } from "@modelcontextprotocol/server";
import { AuditTargetError } from "@/audits";
import { UnsafeUrlError } from "@/core/url-guard";
import { GoogleIntegrationError } from "@/integrations/google/errors";

export function text(markdown: string): CallToolResult {
  return { content: [{ type: "text", text: markdown }] };
}

export function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Converts expected errors into readable tool errors; logs unexpected ones. */
export function guard<Args>(handler: (args: Args) => Promise<CallToolResult>): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof AuditTargetError || error instanceof UnsafeUrlError || error instanceof GoogleIntegrationError) {
        return failure(error.message);
      }
      console.error("[mcp] tool failed", error);
      return failure("Something went wrong while running this check. Please try again in a moment.");
    }
  };
}
