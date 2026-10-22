import { NextResponse, type NextRequest } from "next/server";

/**
 * People often paste the site root instead of /api/mcp as the connector URL.
 * MCP clients POST (or open an event stream) there, so route those requests
 * to the MCP endpoint while normal browser visits still get the landing page.
 */
export function proxy(request: NextRequest) {
  const wantsStream = request.headers.get("accept")?.includes("text/event-stream") ?? false;
  if (request.method === "POST" || request.method === "DELETE" || wantsStream) {
    // Tells the MCP route the connector was added with the root URL, for the sign-in discovery link.
    const headers = new Headers(request.headers);
    headers.set("x-mcp-entry", "root");
    return NextResponse.rewrite(new URL("/api/mcp", request.url), { request: { headers } });
  }
  return NextResponse.next();
}

export const config = { matcher: "/" };
