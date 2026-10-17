import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

describe("Google connection lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("PUBLIC_BASE_URL", "https://audit.example.test");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("connects with PKCE, refreshes and disconnects", async () => {
    const requests: { url: string; body: string }[] = [];
    let accessCounter = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = String(init?.body ?? "");
        requests.push({ url: String(url), body });
        if (String(url).includes("/token")) {
          accessCounter += 1;
          const params = new URLSearchParams(body);
          return Response.json({
            access_token: `access-${accessCounter}`,
            ...(params.get("grant_type") === "authorization_code" ? { refresh_token: "refresh-1", id_token: idToken("owner@acme.test") } : {}),
            expires_in: params.get("grant_type") === "authorization_code" ? 0 : 3600,
            scope: "openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly",
          });
        }
        return new Response("", { status: 200 });
      }),
    );

    const google = await import("@/integrations/google/connections");
    const { connectionId, signInUrl } = await google.createConnection();
    expect(connectionId).toMatch(/^gconn_/);
    expect(signInUrl).toMatch(/^https:\/\/audit\.example\.test\/api\/google\/connect\?start=/);
    expect((await google.connectionStatus(connectionId)).status).toBe("pending");

    const start = new URL(signInUrl).searchParams.get("start")!;
    const consentUrl = new URL(await google.beginAuthorization(start));
    expect(consentUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consentUrl.searchParams.get("scope")).toContain("webmasters.readonly");
    expect(consentUrl.searchParams.get("redirect_uri")).toBe("https://audit.example.test/api/google/callback");
    await expect(google.beginAuthorization(start)).rejects.toThrow(/expired or was already used/);

    const state = consentUrl.searchParams.get("state")!;
    expect(await google.completeAuthorization(state, "auth-code")).toEqual({ email: "owner@acme.test" });
    expect(new URLSearchParams(requests[0]!.body).get("code_verifier")).toBeTruthy();
    await expect(google.completeAuthorization(state, "auth-code")).rejects.toThrow(/expired/);

    const status = await google.connectionStatus(connectionId);
    expect(status).toMatchObject({ status: "connected", email: "owner@acme.test", searchConsole: true, analytics: true });

    // The first access token was issued with expires_in 0, so this refreshes.
    expect(await google.getAccessToken(connectionId)).toBe("access-2");
    expect(await google.getAccessToken(connectionId)).toBe("access-2");

    expect(await google.disconnect(connectionId)).toBe(true);
    expect(requests.some((request) => request.url.includes("/revoke"))).toBe(true);
    expect((await google.connectionStatus(connectionId)).status).toBe("not_found");
  });

  it("explains when Google is not configured", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    const google = await import("@/integrations/google/connections");
    await expect(google.createConnection()).rejects.toThrow(/isn.t available on this server yet/);
  });

  it("rejects malformed connection IDs", async () => {
    const google = await import("@/integrations/google/connections");
    await expect(google.connectionStatus("abc")).rejects.toThrow(/not valid/);
  });
});
