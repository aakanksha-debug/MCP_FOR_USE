import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { isConnectorSignInEnabled, verifyAccessToken } from "@/auth/server";
import { publicBaseUrl, verboseLogs } from "@/config/env";
import { SERVER_INSTRUCTIONS } from "@/mcp/instructions";
import { registerTools, SERVER_INFO } from "@/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mcp = createMcpHandler(registerTools, {
  serverInfo: SERVER_INFO,
  instructions: SERVER_INSTRUCTIONS,
  verboseLogs: verboseLogs(),
});

const verify = (_request: Request, token?: string) => verifyAccessToken(token);

/**
 * Adding the connector requires signing in (Google, or "continue without
 * Google"); requests without a valid token get a 401 that points Claude to
 * the sign-in. The discovery link matches the URL the connector was added with.
 */
async function handler(request: Request): Promise<Response> {
  if (!isConnectorSignInEnabled()) return mcp(request);
  const enteredAtRoot = request.headers.get("x-mcp-entry") === "root";
  return withMcpAuth(mcp, verify, {
    required: true,
    resourceUrl: publicBaseUrl(),
    resourceMetadataPath: enteredAtRoot ? "/.well-known/oauth-protected-resource" : "/.well-known/oauth-protected-resource/api/mcp",
  })(request);
}

export { handler as GET, handler as POST, handler as DELETE };
