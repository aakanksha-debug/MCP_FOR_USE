import { approveAuthorization, loadAuthorizationRequest, OAuthFailure, startAuthorization } from "@/auth/server";
import { beginLoginAuthorization, isGoogleConfigured } from "@/integrations/google/connections";
import { GoogleIntegrationError } from "@/integrations/google/errors";
import { authorizePage } from "@/web/authorize-page";
import { messagePage } from "@/web/html";
import { isSameOrigin } from "@/web/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPIRED = "This sign-in request has expired. Go back to Claude and connect the connector again.";

function failurePage(error: unknown): Response {
  const known = error instanceof OAuthFailure || error instanceof GoogleIntegrationError;
  if (!known) console.error("[oauth] authorize failed", error);
  return messagePage("Could not finish connecting", known ? error.message : "Something went wrong. Go back to Claude and try again.", false, 400);
}

/** Opened by Claude when the connector is added: shows "Sign in with Google" or "Continue without Google". */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const existing = params.get("request");
    if (existing) {
      const pending = await loadAuthorizationRequest(existing);
      if (!pending) return messagePage("Sign-in expired", EXPIRED, false, 400);
      return authorizePage({
        requestId: existing,
        ...(pending.clientName ? { clientName: pending.clientName } : {}),
        redirectUri: pending.redirectUri,
        googleAvailable: isGoogleConfigured(),
        ...(params.get("google") === "cancelled"
          ? { notice: "Google sign-in was cancelled or not allowed for that account. Try again, or continue without Google." }
          : {}),
      });
    }

    const start = await startAuthorization(params);
    if (start.kind === "error") return messagePage("Could not connect", start.message, false, 400);
    if (start.kind === "redirect") return Response.redirect(start.url, 302);
    return authorizePage({
      requestId: start.requestId,
      ...(start.request.clientName ? { clientName: start.request.clientName } : {}),
      redirectUri: start.request.redirectUri,
      googleAvailable: isGoogleConfigured(),
    });
  } catch (error) {
    return failurePage(error);
  }
}

/** The user's choice on the page. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });
  const form = await request.formData();
  const requestId = String(form.get("request") ?? "");
  const action = String(form.get("action") ?? "");
  try {
    if (action === "google" && isGoogleConfigured()) {
      if (!(await loadAuthorizationRequest(requestId))) return messagePage("Sign-in expired", EXPIRED, false, 400);
      return Response.redirect(await beginLoginAuthorization(requestId), 303);
    }
    return Response.redirect(await approveAuthorization(requestId), 303);
  } catch (error) {
    return failurePage(error);
  }
}
