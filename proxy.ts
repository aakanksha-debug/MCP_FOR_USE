import { NextResponse, type NextRequest } from "next/server";

/**
 * People often paste the site root instead of /api/mcp as the connector URL.
 * MCP clients POST (or open an event stream) there, so route those requests
 * to the MCP endpoint while normal browser visits still get the landing page.
 */
export function proxy(request: NextRequest) {
  const wantsStream = request.headers.get("accept")?.includes("text/event-stream") ?? false;
  if (request.method === "POST" || request.method === "DELETE" || wantsStream) {
    return NextResponse.rewrite(new URL("/api/mcp", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: "/" };
