/**
 * Central, typed access to environment configuration.
 *
 * Nothing secret is hard-coded here: every credential comes from the
 * environment (Vercel project settings in production, .env.local locally).
 * Read through these helpers instead of touching process.env elsewhere so the
 * full configuration surface stays in one place.
 */

function read(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function isProductionDeployment(): boolean {
  return read("VERCEL_ENV") === "production";
}

/** Public origin of this deployment, without a trailing slash. */
export function publicBaseUrl(): string {
  const explicit = read("PUBLIC_BASE_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const production = read("VERCEL_PROJECT_PRODUCTION_URL");
  if (production && isProductionDeployment()) return `https://${production}`;
  const deployment = read("VERCEL_URL");
  if (deployment) return `https://${deployment}`;
  return "http://localhost:3000";
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Returns null when Google sign-in is not configured on this deployment. */
export function googleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = read("GOOGLE_CLIENT_ID");
  const clientSecret = read("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: `${publicBaseUrl()}/api/google/callback`,
  };
}

/** Base64 AES-256 key for encrypting stored OAuth tokens, or null. */
export function tokenEncryptionKey(): Buffer | null {
  const raw = read("TOKEN_ENCRYPTION_KEY");
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64.");
  }
  return key;
}

export interface RedisRestConfig {
  url: string;
  token: string;
}

export function redisRestConfig(): RedisRestConfig | null {
  const url = read("KV_REST_API_URL") ?? read("UPSTASH_REDIS_REST_URL");
  const token = read("KV_REST_API_TOKEN") ?? read("UPSTASH_REDIS_REST_TOKEN");
  return url && token ? { url, token } : null;
}

export interface BlobStorageConfig {
  /** Static read-write token; absent when the store is reached through Vercel OIDC. */
  token?: string;
}

/** A private Vercel Blob store connected to the project, or null. */
export function blobStorageConfig(): BlobStorageConfig | null {
  const token = read("BLOB_READ_WRITE_TOKEN");
  if (token) return { token };
  return read("BLOB_STORE_ID") ? {} : null;
}

/**
 * Whether adding the connector asks the user to sign in (with Google, or
 * "continue without Google"). On by default; MCP_SIGN_IN=off turns the MCP
 * back into an open, authless server.
 */
export function connectorSignInSetting(): boolean {
  return read("MCP_SIGN_IN") !== "off";
}

export function pageSpeedApiKey(): string | undefined {
  return read("PAGESPEED_API_KEY");
}

/**
 * Lets audits reach localhost and private networks. Only for testing against a
 * local site; always off on a Vercel production deployment.
 */
export function allowPrivateHosts(): boolean {
  if (isProductionDeployment()) return false;
  return read("AUDIT_ALLOW_PRIVATE_HOSTS") === "true";
}

export function verboseLogs(): boolean {
  return read("MCP_VERBOSE_LOGS") === "true";
}

export function contactUrlOverride(): string | undefined {
  return read("INCREMENTORS_CONTACT_URL");
}
