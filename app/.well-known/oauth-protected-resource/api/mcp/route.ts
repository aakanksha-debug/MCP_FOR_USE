import { protectedResourceMetadata } from "@/auth/server";
import { json, preflight } from "@/web/oauth-response";

export const dynamic = "force-dynamic";

/** Protected resource metadata (RFC 9728) for connectors added with the /api/mcp URL. */
export function GET() {
  return json(protectedResourceMetadata("/api/mcp"));
}

export const OPTIONS = preflight;
