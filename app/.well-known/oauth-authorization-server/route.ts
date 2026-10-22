import { authorizationServerMetadata } from "@/auth/server";
import { json, preflight } from "@/web/oauth-response";

export const dynamic = "force-dynamic";

/** OAuth authorization server metadata (RFC 8414). */
export function GET() {
  return json(authorizationServerMetadata());
}

export const OPTIONS = preflight;
