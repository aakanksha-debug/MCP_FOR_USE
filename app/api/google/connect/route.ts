import { beginAuthorization } from "@/integrations/google/connections";
import { GoogleIntegrationError } from "@/integrations/google/errors";
import { messagePage } from "@/web/html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One-time sign-in link from google_connect: redirects to Google's consent screen. */
export async function GET(request: Request) {
  const start = new URL(request.url).searchParams.get("start");
  if (!start) return messagePage("Invalid link", "This sign-in link is incomplete. Ask Claude for a new one.", false, 400);
  try {
    const authorizationUrl = await beginAuthorization(start);
    return new Response(null, { status: 302, headers: { location: authorizationUrl, "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof GoogleIntegrationError ? error.message : "Something went wrong. Ask Claude for a new sign-in link.";
    if (!(error instanceof GoogleIntegrationError)) console.error("[google] connect failed", error);
    return messagePage("Could not start Google sign-in", message, false, 400);
  }
}
