import { registerClient } from "@/auth/server";
import { json, oauthError, preflight } from "@/web/oauth-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dynamic client registration (RFC 7591), used by Claude when the connector is added. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return json(registerClient(body), 201);
  } catch (error) {
    return oauthError(error);
  }
}

export const OPTIONS = preflight;
