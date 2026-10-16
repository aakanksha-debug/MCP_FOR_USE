import { completeAuthorization } from "@/integrations/google/connections";
import { GoogleIntegrationError } from "@/integrations/google/errors";
import { messagePage } from "@/web/html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Google redirects here after the user approves (or denies) access. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const error = params.get("error");

  if (error) {
    return messagePage(
      "Google access was not granted",
      "No data was shared. You can close this tab and keep using the website audits in Claude without Google data.",
      false,
    );
  }
  if (!state || !code) return messagePage("Invalid response", "Google sign-in did not complete. Ask Claude for a new link.", false, 400);

  try {
    const { email } = await completeAuthorization(state, code);
    return messagePage(
      "Google connected",
      `Connected${email ? ` as ${email}` : ""} with read-only access to Search Console and Analytics. You can close this tab and tell Claude you're done.`,
      true,
    );
  } catch (err) {
    const message = err instanceof GoogleIntegrationError ? err.message : "Something went wrong while connecting Google. Ask Claude for a new link.";
    if (!(err instanceof GoogleIntegrationError)) console.error("[google] callback failed", err);
    return messagePage("Could not connect Google", message, false, 400);
  }
}
