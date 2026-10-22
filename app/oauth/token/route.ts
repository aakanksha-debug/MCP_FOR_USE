import { exchangeToken } from "@/auth/server";
import { json, oauthError, preflight } from "@/web/oauth-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function formOf(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]));
  }
  return new URLSearchParams(await request.text());
}

/** Token endpoint: exchanges authorization codes and refresh tokens. */
export async function POST(request: Request) {
  try {
    return json(await exchangeToken(await formOf(request), request.headers.get("authorization")));
  } catch (error) {
    return oauthError(error);
  }
}

export const OPTIONS = preflight;
