import type { GoogleOAuthConfig } from "@/config/env";
import { GoogleIntegrationError } from "./errors";

/** Read-only scopes, requested progressively. The MCP never asks to change Google data. */
export type GoogleService = "search_console" | "analytics";

export const SERVICE_SCOPES: Record<GoogleService, string> = {
  search_console: "https://www.googleapis.com/auth/webmasters.readonly",
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
};

export const BASE_SCOPES = ["openid", "email"] as const;

export function scopesFor(services: GoogleService[]): string[] {
  return [...BASE_SCOPES, ...services.map((service) => SERVICE_SCOPES[service])];
}

export function grantedServices(scope: string): GoogleService[] {
  return (Object.keys(SERVICE_SCOPES) as GoogleService[]).filter((service) => scope.includes(SERVICE_SCOPES[service]));
}

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  email?: string;
}

export function buildAuthorizationUrl(config: GoogleOAuthConfig, state: string, codeChallenge: string, scopes: string[]): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as TokenResponse;
  if (!response.ok || body.error) {
    if (body.error === "invalid_grant") {
      throw new GoogleIntegrationError("Google access has expired or was revoked. Please reconnect Google.", "expired");
    }
    throw new GoogleIntegrationError(`Google sign-in failed: ${body.error_description ?? body.error ?? response.status}`);
  }
  return body;
}

/**
 * Reads the email claim from the ID token. The token comes straight from
 * Google's token endpoint over TLS, so its signature does not need checking
 * (OpenID Connect Core 3.1.3.7).
 */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
    return claims.email;
  } catch {
    return undefined;
  }
}

function toTokens(body: TokenResponse, previousRefreshToken?: string): GoogleTokens {
  const refreshToken = body.refresh_token ?? previousRefreshToken;
  const email = emailFromIdToken(body.id_token);
  return {
    accessToken: body.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: Date.now() + body.expires_in * 1000,
    scope: body.scope,
    ...(email ? { email } : {}),
  };
}

export async function exchangeCode(config: GoogleOAuthConfig, code: string, codeVerifier: string): Promise<GoogleTokens> {
  const body = await tokenRequest({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
  return toTokens(body);
}

export async function refreshTokens(config: GoogleOAuthConfig, refreshToken: string): Promise<GoogleTokens> {
  const body = await tokenRequest({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });
  return toTokens(body, refreshToken);
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}
