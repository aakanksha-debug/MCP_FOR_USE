import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pkceChallenge, randomToken } from "@/integrations/storage/crypto";

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

function stubGoogle() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      if (String(url).includes("/token")) {
        return Response.json({
          access_token: "google-access",
          refresh_token: "google-refresh",
          id_token: idToken("owner@acme.test"),
          expires_in: 3600,
          scope: "openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly",
        });
      }
      return new Response("", { status: 200 });
    }),
  );
}

async function authorizeParams(clientId: string, verifier: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: "S256",
    state: "claude-state",
    resource: "https://audit.example.test/api/mcp",
    ...extra,
  });
}

describe("connector sign-in", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("PUBLIC_BASE_URL", "https://audit.example.test");
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    vi.stubEnv("BLOB_STORE_ID", "");
    vi.stubEnv("MCP_SIGN_IN", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("publishes discovery metadata that points at its own endpoints", async () => {
    const auth = await import("@/auth/server");
    expect(auth.authorizationServerMetadata()).toMatchObject({
      issuer: "https://audit.example.test",
      authorization_endpoint: "https://audit.example.test/oauth/authorize",
      token_endpoint: "https://audit.example.test/oauth/token",
      registration_endpoint: "https://audit.example.test/oauth/register",
      code_challenge_methods_supported: ["S256"],
    });
    expect(auth.protectedResourceMetadata("/api/mcp")).toMatchObject({
      resource: "https://audit.example.test/api/mcp",
      authorization_servers: ["https://audit.example.test"],
    });
    expect(auth.protectedResourceMetadata("").resource).toBe("https://audit.example.test");
  });

  it("registers Claude, signs in without Google and issues working tokens", async () => {
    const auth = await import("@/auth/server");
    const client = auth.registerClient({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "client_secret_post", client_name: "Claude" });
    const clientId = String(client.client_id);
    const clientSecret = String(client.client_secret);
    expect(clientId).toMatch(/^mcpc_/);

    const verifier = randomToken(48);
    const start = await auth.startAuthorization(await authorizeParams(clientId, verifier));
    expect(start.kind).toBe("ok");
    if (start.kind !== "ok") return;
    expect(start.request.clientName).toBe("Claude");

    const redirect = new URL(await auth.approveAuthorization(start.requestId));
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(redirect.searchParams.get("state")).toBe("claude-state");
    expect(redirect.searchParams.get("iss")).toBe("https://audit.example.test");
    const code = redirect.searchParams.get("code")!;
    await expect(auth.approveAuthorization(start.requestId)).rejects.toThrow(/expired/);

    const form = (values: Record<string, string>) => new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...values });
    await expect(
      auth.exchangeToken(form({ grant_type: "authorization_code", code, code_verifier: "wrong".repeat(10), redirect_uri: CLAUDE_CALLBACK }), null),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const second = await auth.startAuthorization(await authorizeParams(clientId, verifier));
    if (second.kind !== "ok") throw new Error("expected ok");
    const code2 = new URL(await auth.approveAuthorization(second.requestId)).searchParams.get("code")!;
    const tokens = await auth.exchangeToken(form({ grant_type: "authorization_code", code: code2, code_verifier: verifier, redirect_uri: CLAUDE_CALLBACK }), null);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: auth.ACCESS_TOKEN_TTL, scope: "audit" });
    await expect(
      auth.exchangeToken(form({ grant_type: "authorization_code", code: code2, code_verifier: verifier }), null),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const info = auth.verifyAccessToken(String(tokens.access_token));
    expect(info).toMatchObject({ scopes: ["audit"], extra: {} });
    expect(auth.verifyAccessToken(String(tokens.refresh_token))).toBeUndefined();
    expect(auth.verifyAccessToken("mcpa_forged")).toBeUndefined();

    const refreshed = await auth.exchangeToken(form({ grant_type: "refresh_token", refresh_token: String(tokens.refresh_token) }), null);
    expect(auth.verifyAccessToken(String(refreshed.access_token))).toBeDefined();

    const basic = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent("wrong")}`).toString("base64")}`;
    await expect(auth.exchangeToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(tokens.refresh_token) }), basic)).rejects.toMatchObject({
      code: "invalid_client",
    });
  });

  it("stops unknown clients, unregistered redirects and requests without PKCE", async () => {
    const auth = await import("@/auth/server");
    const clientId = String(auth.registerClient({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }).client_id);
    const verifier = randomToken(48);

    expect((await auth.startAuthorization(await authorizeParams("mcpc_nope", verifier))).kind).toBe("error");
    expect((await auth.startAuthorization(await authorizeParams(clientId, verifier, { redirect_uri: "https://evil.example/cb" }))).kind).toBe("error");

    const noPkce = await auth.startAuthorization(await authorizeParams(clientId, verifier, { code_challenge_method: "plain" }));
    expect(noPkce.kind).toBe("redirect");
    if (noPkce.kind === "redirect") expect(new URL(noPkce.url).searchParams.get("error")).toBe("invalid_request");

    expect(() => auth.registerClient({ redirect_uris: ["http://evil.example/cb"] })).toThrow(/redirect_uris/);
    expect(() => auth.registerClient({ redirect_uris: ["javascript:alert(1)"] })).toThrow(/redirect_uris/);
  });

  it("lets loopback clients use any port, as desktop and CLI clients do", async () => {
    const auth = await import("@/auth/server");
    const clientId = String(auth.registerClient({ redirect_uris: ["http://127.0.0.1:3000/callback"], token_endpoint_auth_method: "none" }).client_id);
    const verifier = randomToken(48);
    const start = await auth.startAuthorization(await authorizeParams(clientId, verifier, { redirect_uri: "http://127.0.0.1:54321/callback" }));
    expect(start.kind).toBe("ok");
  });

  it("puts the Google connection from sign-in into the access token", async () => {
    stubGoogle();
    const auth = await import("@/auth/server");
    const google = await import("@/integrations/google/connections");
    const clientId = String(auth.registerClient({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }).client_id);
    const verifier = randomToken(48);
    const start = await auth.startAuthorization(await authorizeParams(clientId, verifier));
    if (start.kind !== "ok") throw new Error("expected ok");

    const consent = new URL(await google.beginLoginAuthorization(start.requestId));
    expect(consent.searchParams.get("scope")).toContain("webmasters.readonly");
    expect(consent.searchParams.get("scope")).toContain("analytics.readonly");

    const result = await google.completeAuthorization(consent.searchParams.get("state")!, "google-code");
    expect(result.email).toBe("owner@acme.test");
    expect(result.login?.requestId).toBe(start.requestId);
    const connectionId = result.login!.connectionId;
    expect(connectionId).toMatch(/^gconn_/);

    const code = new URL(await auth.approveAuthorization(start.requestId, connectionId)).searchParams.get("code")!;
    const tokens = await auth.exchangeToken(new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId }), null);
    const info = auth.verifyAccessToken(String(tokens.access_token));
    expect(info?.extra?.googleConnectionId).toBe(connectionId);
    expect(await google.connectionStatus(connectionId)).toMatchObject({ status: "connected", searchConsole: true, analytics: true });

    const refreshed = await auth.exchangeToken(new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(tokens.refresh_token), client_id: clientId }), null);
    expect(auth.verifyAccessToken(String(refreshed.access_token))?.extra?.googleConnectionId).toBe(connectionId);
  });

  it("returns to the choice page when Google sign-in is cancelled", async () => {
    const auth = await import("@/auth/server");
    const google = await import("@/integrations/google/connections");
    const clientId = String(auth.registerClient({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }).client_id);
    const start = await auth.startAuthorization(await authorizeParams(clientId, randomToken(48)));
    if (start.kind !== "ok") throw new Error("expected ok");
    const consent = new URL(await google.beginLoginAuthorization(start.requestId));

    const { GET } = await import("../app/api/google/callback/route");
    const response = await GET(new Request(`https://audit.example.test/api/google/callback?error=access_denied&state=${consent.searchParams.get("state")}`));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/oauth/authorize");
    expect(location.searchParams.get("request")).toBe(start.requestId);
    expect(location.searchParams.get("google")).toBe("cancelled");
  });

  it("shows the sign-in page with both choices", async () => {
    const auth = await import("@/auth/server");
    const clientId = String(auth.registerClient({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none", client_name: "Claude" }).client_id);
    const { GET } = await import("../app/oauth/authorize/route");
    const response = await GET(new Request(`https://audit.example.test/oauth/authorize?${await authorizeParams(clientId, randomToken(48))}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const html = await response.text();
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("Continue without Google");
    expect(html).toContain("Claude wants to use");
    expect(html).toContain("After signing in you return to claude.ai.");

    const other = String(auth.registerClient({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none", client_name: "Claude" }).client_id);
    const params = await authorizeParams(other, randomToken(48), { redirect_uri: "https://evil.example/cb" });
    const warned = await (await GET(new Request(`https://audit.example.test/oauth/authorize?${params}`))).text();
    expect(warned).toContain("<strong>evil.example</strong>, which is not Claude");
  });

  it("asks MCP clients to sign in, then serves tools with the signed-in Google connection", async () => {
    const auth = await import("@/auth/server");
    const { POST } = await import("../app/api/mcp/route");
    const call = (body: object, token?: string) =>
      POST(
        new Request("https://audit.example.test/api/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    };

    const anonymous = await call(initialize);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://audit.example.test/.well-known/oauth-protected-resource/api/mcp"',
    );

    const clientId = String(auth.registerClient({ redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "none" }).client_id);
    const verifier = randomToken(48);
    const start = await auth.startAuthorization(await authorizeParams(clientId, verifier));
    if (start.kind !== "ok") throw new Error("expected ok");
    const code = new URL(await auth.approveAuthorization(start.requestId, "gconn_" + "x".repeat(43))).searchParams.get("code")!;
    const tokens = await auth.exchangeToken(new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId }), null);

    const ok = await call(initialize, String(tokens.access_token));
    expect(ok.status).toBe(200);

    const status = await call(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "google_connection_status", arguments: {} } },
      String(tokens.access_token),
    );
    const text = await status.text();
    // The signed-in connection was used (no connectionId passed); it does not exist in this test store.
    expect(text).toContain("No connection found");
  });
});
