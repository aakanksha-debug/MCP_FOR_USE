import { createMcpHandler } from "mcp-handler";
import { verboseLogs } from "@/config/env";
import { SERVER_INSTRUCTIONS } from "@/mcp/instructions";
import { registerTools, SERVER_INFO } from "@/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler(registerTools, {
  serverInfo: SERVER_INFO,
  instructions: SERVER_INSTRUCTIONS,
  verboseLogs: verboseLogs(),
});

export { handler as GET, handler as POST, handler as DELETE };
