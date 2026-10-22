import { approveAuthorization, OAuthFailure } from "@/auth/server";
import { abandonAuthorization, completeAuthorization } from "@/integrations/google/connections";
import { GoogleIntegrationError } from "@/integrations/google/errors";
import { messagePage } from "@/web/html";
import { sameHostUrl } from "@/web/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Google redirects here after the user approves (or denies) access. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  const code = params.get("code");
  const error = params.get("error");

  if (error) {
    // During connector setup, go back to the choice page so the user can retry or continue without Google.
    const requestId = state ? await abandonAuthorization(state).catch(() => undefined) : undefined;
    if (requestId) {
      const back = sameHostUrl(request, "/oauth/authorize");
      back.searchParams.set("request", requestId);
      back.searchParams.set("google", "cancelled");
      return Response.redirect(back, 303);
    }
    return messagePage(
      "Google access was not granted",
      "No data was shared. You can close this tab and keep using the website audits in Claude without Google data.",
      false,
    );
  }
  if (!state || !code) return messagePage("Invalid response", "Google sign-in did not complete. Ask Claude for a new link.", false, 400);

  try {
    const { email, login } = await completeAuthorization(state, code);
    if (login) return Response.redirect(await approveAuthorization(login.requestId, login.connectionId), 303);
    return messagePage(
      "Google connected",
      `Connected${email ? ` as ${email}` : ""} with read-only access to Search Console and Analytics. You can close this tab and tell Claude you're done.`,
      true,
    );
  } catch (err) {
    const known = err instanceof GoogleIntegrationError || err instanceof OAuthFailure;
    if (!known) console.error("[google] callback failed", err);
    const message = known ? err.message : "Something went wrong while connecting Google. Ask Claude for a new link.";
    return messagePage("Could not connect Google", message, false, 400);
  }
}
