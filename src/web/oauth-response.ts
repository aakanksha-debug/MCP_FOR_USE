import { OAuthFailure } from "@/auth/server";

/** CORS for discovery, registration and token endpoints, which browser-based MCP clients call directly. */
export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
} as const;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...CORS_HEADERS },
  });
}

/** OAuth error responses (RFC 6749 section 5.2); unexpected errors are logged and hidden. */
export function oauthError(error: unknown): Response {
  if (error instanceof OAuthFailure) {
    return json({ error: error.code, error_description: error.message }, error.status);
  }
  console.error("[oauth] request failed", error);
  return json({ error: "server_error", error_description: "Something went wrong. Please try again." }, 500);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
