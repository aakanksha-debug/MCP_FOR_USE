import type { AuthInfo } from "@modelcontextprotocol/server";
import { connectorSignInSetting, publicBaseUrl, tokenEncryptionKey } from "@/config/env";
import { hashKey, pkceChallenge, randomToken } from "@/integrations/storage/crypto";
import { getStore, type KeyValueStore } from "@/integrations/storage/kv";
import { safeEqual, seal, sign, unseal } from "./tokens";

/**
 * OAuth 2.1 authorization server for the connector itself (MCP authorization).
 *
 * When someone adds the connector, Claude registers itself (dynamic client
 * registration) and opens /oauth/authorize. There the user signs in with
 * Google (read-only Search Console and Analytics) or continues without
 * Google. Claude then exchanges the code for tokens. The access token carries
 * the user's Google connection, so every tool can use that data without
 * asking again. Client IDs and tokens are sealed, so only short-lived
 * authorization requests and codes are stored.
 */

export const SCOPE = "audit";
export const ACCESS_TOKEN_TTL = 60 * 60;
export const REFRESH_TOKEN_TTL = 90 * 24 * 60 * 60;
const REQUEST_TTL = 15 * 60;
const CODE_TTL = 5 * 60;

const CLIENT_PREFIX = "mcpc_";
const ACCESS_PREFIX = "mcpa_";
const REFRESH_PREFIX = "mcpr_";
const GOOGLE_PREFIX = "mcpg_";

type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";
const AUTH_METHODS: AuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

interface ClientRecord {
  redirectUris: string[];
  name?: string;
  auth: AuthMethod;
  iat: number;
}

export interface AuthorizationRequest {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource?: string;
  google?: string;
}

interface TokenPayload {
  cid: string;
  scope: string;
  exp: number;
  resource?: string;
  google?: string;
}

export class OAuthFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Sign-in is used when it is not switched off and its key and storage exist. */
export function isConnectorSignInEnabled(): boolean {
  return connectorSignInSetting() && Boolean(tokenEncryptionKey()) && Boolean(getStore());
}

function store(): KeyValueStore {
  const kv = getStore();
  if (!kv) throw new OAuthFailure("temporarily_unavailable", "Sign-in storage is not configured on this server.", 503);
  return kv;
}

export function authorizationServerMetadata() {
  const base = publicBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: GRANT_TYPES,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: AUTH_METHODS,
    scopes_supported: [SCOPE],
    service_documentation: `${base}/`,
  };
}

/** RFC 9728 metadata. The resource is the URL the client connected to: the site root or /api/mcp. */
export function protectedResourceMetadata(resourcePath: "" | "/api/mcp") {
  const base = publicBaseUrl();
  return {
    resource: `${base}${resourcePath}`,
    authorization_servers: [base],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Incrementors Website Audit",
  };
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const url = new URL(value);
    if (url.hash || BLOCKED_SCHEMES.has(url.protocol)) return false;
    if (url.protocol === "http:") return isLoopback(url);
    return true;
  } catch {
    return false;
  }
}

/** Exact match, except that loopback redirects may use any port (RFC 8252). */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    return isLoopback(a) && isLoopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function withParams(url: string, params: Record<string, string>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

const clientSecretFor = (clientId: string) => sign(`client-secret:${clientId}`);
const readClient = (clientId: string | null | undefined) => unseal<ClientRecord>(CLIENT_PREFIX, clientId);

/** Dynamic client registration (RFC 7591). The client ID is the sealed registration itself. */
export function registerClient(body: unknown): Record<string, unknown> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  if (!redirectUris.length || redirectUris.length > 10 || !redirectUris.every(validRedirectUri)) {
    throw new OAuthFailure("invalid_redirect_uri", "Provide 1 to 10 redirect_uris using https (or http on localhost).");
  }
  const auth = (input.token_endpoint_auth_method ?? "client_secret_basic") as AuthMethod;
  if (!AUTH_METHODS.includes(auth)) throw new OAuthFailure("invalid_client_metadata", "Unsupported token_endpoint_auth_method.");
  const grantTypes = Array.isArray(input.grant_types) ? input.grant_types : GRANT_TYPES;
  if (!grantTypes.every((grant) => GRANT_TYPES.includes(String(grant)))) {
    throw new OAuthFailure("invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported.");
  }
  const name = typeof input.client_name === "string" ? input.client_name.slice(0, 100) : undefined;
  const iat = nowSeconds();
  const clientId = seal(CLIENT_PREFIX, { redirectUris, ...(name ? { name } : {}), auth, iat } satisfies ClientRecord);
  return {
    client_id: clientId,
    client_id_issued_at: iat,
    ...(auth === "none" ? {} : { client_secret: clientSecretFor(clientId), client_secret_expires_at: 0 }),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: auth,
    grant_types: GRANT_TYPES,
    response_types: ["code"],
    scope: SCOPE,
    ...(name ? { client_name: name } : {}),
  };
}

export type AuthorizeStart =
  | { kind: "error"; message: string }
  | { kind: "redirect"; url: string }
  | { kind: "ok"; requestId: string; request: AuthorizationRequest };

/**
 * Validates an authorization request. Problems with the client or redirect
 * address are shown on the page (never redirected); other problems are sent
 * back to the client's redirect address.
 */
export async function startAuthorization(params: URLSearchParams): Promise<AuthorizeStart> {
  const clientId = params.get("client_id");
  const client = readClient(clientId);
  if (!client || !clientId) {
    return { kind: "error", message: "This sign-in link is not valid. Remove the connector in Claude and add it again." };
  }
  const redirectUri = params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
  if (!redirectUri || !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
    return { kind: "error", message: "The sign-in request came from an address that was not registered, so it was stopped." };
  }
  const state = params.get("state") ?? undefined;
  const fail = (error: string, description: string): AuthorizeStart => ({
    kind: "redirect",
    url: withParams(redirectUri, { error, error_description: description, ...(state ? { state } : {}), iss: publicBaseUrl() }),
  });
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = params.get("code_challenge");
  if (!challenge || params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  const resource = params.get("resource") ?? undefined;
  if (resource && !sameOrigin(resource, publicBaseUrl())) return fail("invalid_target", "Unknown resource.");

  const request: AuthorizationRequest = {
    clientId,
    ...(client.name ? { clientName: client.name } : {}),
    redirectUri,
    ...(state ? { state } : {}),
    codeChallenge: challenge,
    scope: SCOPE,
    ...(resource ? { resource } : {}),
  };
  const requestId = randomToken(24);
  await store().set(`oauthreq:${requestId}`, request, REQUEST_TTL);
  return { kind: "ok", requestId, request };
}

export async function loadAuthorizationRequest(requestId: string): Promise<AuthorizationRequest | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(requestId)) return null;
  return store().get<AuthorizationRequest>(`oauthreq:${requestId}`);
}

/** Finishes sign-in (with or without Google) and returns the client redirect carrying a one-time code. */
export async function approveAuthorization(requestId: string, googleConnectionId?: string): Promise<string> {
  const kv = store();
  const request = /^[A-Za-z0-9_-]{20,64}$/.test(requestId) ? await kv.take<AuthorizationRequest>(`oauthreq:${requestId}`) : null;
  if (!request) throw new OAuthFailure("expired", "This sign-in request has expired. Go back to Claude and connect again.");
  const code = randomToken(32);
  const record: CodeRecord = {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
    ...(request.resource ? { resource: request.resource } : {}),
    ...(googleConnectionId ? { google: seal(GOOGLE_PREFIX, { id: googleConnectionId }) } : {}),
  };
  await kv.set(`oauthcode:${hashKey(code)}`, record, CODE_TTL);
  return withParams(request.redirectUri, { code, ...(request.state ? { state: request.state } : {}), iss: publicBaseUrl() });
}

function clientCredentials(form: URLSearchParams, authorization: string | null): { clientId: string | null; secret: string | null } {
  if (authorization?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
      const split = decoded.indexOf(":");
      if (split > 0) return { clientId: decodeURIComponent(decoded.slice(0, split)), secret: decodeURIComponent(decoded.slice(split + 1)) };
    } catch {
      return { clientId: null, secret: null };
    }
  }
  return { clientId: form.get("client_id"), secret: form.get("client_secret") };
}

function issueTokens(base: Omit<TokenPayload, "exp">): Record<string, unknown> {
  const now = nowSeconds();
  return {
    access_token: seal(ACCESS_PREFIX, { ...base, exp: now + ACCESS_TOKEN_TTL } satisfies TokenPayload),
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: seal(REFRESH_PREFIX, { ...base, exp: now + REFRESH_TOKEN_TTL } satisfies TokenPayload),
    scope: base.scope,
  };
}

/** Token endpoint: authorization_code (with PKCE) and refresh_token grants. */
export async function exchangeToken(form: URLSearchParams, authorization: string | null): Promise<Record<string, unknown>> {
  const { clientId, secret } = clientCredentials(form, authorization);
  const client = readClient(clientId);
  if (!client || !clientId) throw new OAuthFailure("invalid_client", "Unknown client.", 401);
  if (client.auth !== "none" && (!secret || !safeEqual(secret, clientSecretFor(clientId)))) {
    throw new OAuthFailure("invalid_client", "Client authentication failed.", 401);
  }
  const cid = hashKey(clientId);

  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!code || !verifier) throw new OAuthFailure("invalid_request", "code and code_verifier are required.");
    const record = await store().take<CodeRecord>(`oauthcode:${hashKey(code)}`);
    if (!record || record.clientId !== clientId) throw new OAuthFailure("invalid_grant", "The authorization code is invalid or has expired.");
    const redirectUri = form.get("redirect_uri");
    if (redirectUri && redirectUri !== record.redirectUri) throw new OAuthFailure("invalid_grant", "redirect_uri does not match the authorization request.");
    if (!safeEqual(pkceChallenge(verifier), record.codeChallenge)) throw new OAuthFailure("invalid_grant", "PKCE verification failed.");
    const google = record.google ? unseal<{ id: string }>(GOOGLE_PREFIX, record.google)?.id : undefined;
    return issueTokens({ cid, scope: record.scope, ...(record.resource ? { resource: record.resource } : {}), ...(google ? { google } : {}) });
  }

  if (grant === "refresh_token") {
    const payload = unseal<TokenPayload>(REFRESH_PREFIX, form.get("refresh_token"));
    if (!payload || payload.exp < nowSeconds() || payload.cid !== cid) throw new OAuthFailure("invalid_grant", "The refresh token is invalid or has expired.");
    const { exp: _expired, ...rest } = payload;
    return issueTokens(rest);
  }

  throw new OAuthFailure("unsupported_grant_type", "Use the authorization_code or refresh_token grant.");
}

/** Verifies a bearer token on MCP requests. The Google connection travels in `extra`. */
export function verifyAccessToken(token: string | undefined): AuthInfo | undefined {
  const payload = unseal<TokenPayload>(ACCESS_PREFIX, token);
  if (!token || !payload || payload.exp < nowSeconds()) return undefined;
  return {
    token,
    clientId: payload.cid,
    scopes: payload.scope.split(" "),
    expiresAt: payload.exp,
    extra: payload.google ? { googleConnectionId: payload.google } : {},
  };
}
