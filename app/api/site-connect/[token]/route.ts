import { completeSiteConnection } from "@/platforms/connections";
import { PlatformError } from "@/platforms/types";
import { messagePage } from "@/web/html";
import { isSameOrigin, sameHostUrl } from "@/web/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function backWithError(request: Request, token: string, message: string): Response {
  const url = sameHostUrl(request, `/connect/${token}`);
  url.searchParams.set("error", message);
  return Response.redirect(url, 303);
}

/** Receives the connect form: checks consent, verifies the credentials and stores them encrypted. */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isSameOrigin(request)) return new Response("Forbidden", { status: 403 });

  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();
  if (field("consent") !== "yes") return backWithError(request, token, "Please confirm that you allow the changes you approve.");
  if (field("platform") !== "wordpress") return backWithError(request, token, "Only WordPress sites can be connected right now.");
  if (!field("username") || !field("appPassword")) return backWithError(request, token, "Enter your WordPress username and application password.");

  try {
    const identity = await completeSiteConnection(token, {
      platform: "wordpress",
      siteUrl: field("siteUrl"),
      username: field("username"),
      appPassword: field("appPassword"),
    });
    return messagePage(
      "Website connected",
      `Connected to ${identity.siteName ?? identity.siteUrl}${identity.user ? ` as ${identity.user}` : ""}. Go back to Claude and say you're done. Nothing will be published until you approve the changes.`,
      true,
    );
  } catch (error) {
    if (!(error instanceof PlatformError)) console.error("[site-connect] failed", error);
    const message = error instanceof PlatformError ? error.message : "Could not connect the website. Please try again.";
    return backWithError(request, token, message);
  }
}
