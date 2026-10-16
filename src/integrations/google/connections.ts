import { googleOAuthConfig, publicBaseUrl, tokenEncryptionKey, type GoogleOAuthConfig } from "@/config/env";
import { decrypt, encrypt, hashKey, pkceChallenge, randomToken } from "../storage/crypto";
import { getStore, type KeyValueStore } from "../storage/kv";
import { GoogleIntegrationError } from "./errors";
import { buildAuthorizationUrl, exchangeCode, refreshTokens, revokeToken, type GoogleTokens } from "./oauth";

/**
 * Connection lifecycle for the optional Google sign-in.
 *
 * The MCP itself is authless so anyone can add it. When a user wants GSC/GA4
 * data, `google_connect` creates a random connection ID (kept in the Claude
 * conversation) and a one-time sign-in link. After Google sign-in the
 * encrypted tokens are stored under a hash of that ID. Only read-only scopes
 * are requested, and `google_disconnect` revokes access.
 */

const PENDING_TTL = 30 * 60;
const STATE_TTL = 10 * 60;
const CONNECTION_TTL = 30 * 24 * 60 * 60;
const CONNECTION_ID_PREFIX = "gconn_";

interface PendingConnection {
  status: "pending";
  createdAt: number;
}

interface ActiveConnection {
  status: "connected";
  createdAt: number;
  connectedAt: number;
  email?: string;
  scope: string;
  tokens: string;
}

type StoredConnection = PendingConnection | ActiveConnection;

interface StartRecord {
  connectionKey: string;
}

interface StateRecord {
  connectionKey: string;
  verifier: string;
}

interface Dependencies {
  store: KeyValueStore;
  config: GoogleOAuthConfig;
  key: Buffer;
}

function dependencies(): Dependencies {
  const config = googleOAuthConfig();
  const key = tokenEncryptionKey();
  if (!config || !key) {
    throw new GoogleIntegrationError(
      "Google Search Console / GA4 connection is not configured on this server yet. Website audits still work without it.",
      "not_configured",
    );
  }
  const store = getStore();
  if (!store) {
    throw new GoogleIntegrationError("Token storage is not configured on this server, so Google cannot be connected yet.", "storage_unavailable");
  }
  return { store, config, key };
}

export function isGoogleConfigured(): boolean {
  return Boolean(googleOAuthConfig() && tokenEncryptionKey() && getStore());
}

const connectionStorageKey = (connectionId: string) => `gconn:${hashKey(connectionId)}`;

function assertConnectionIdShape(connectionId: string): void {
  if (!connectionId.startsWith(CONNECTION_ID_PREFIX) || connectionId.length < 40) {
    throw new GoogleIntegrationError("That Google connection ID is not valid. Run google_connect to create a new one.", "not_connected");
  }
}

export async function createConnection(): Promise<{ connectionId: string; signInUrl: string; expiresInMinutes: number }> {
  const { store } = dependencies();
  const connectionId = `${CONNECTION_ID_PREFIX}${randomToken(32)}`;
  const connectionKey = connectionStorageKey(connectionId);
  const startToken = randomToken(24);
  await store.set<StoredConnection>(connectionKey, { status: "pending", createdAt: Date.now() }, PENDING_TTL);
  await store.set<StartRecord>(`gstart:${startToken}`, { connectionKey }, PENDING_TTL);
  return {
    connectionId,
    signInUrl: `${publicBaseUrl()}/api/google/connect?start=${encodeURIComponent(startToken)}`,
    expiresInMinutes: PENDING_TTL / 60,
  };
}

/** Consumes the one-time start token and returns Google's consent URL. */
export async function beginAuthorization(startToken: string): Promise<string> {
  const { store, config } = dependencies();
  const start = await store.take<StartRecord>(`gstart:${startToken}`);
  if (!start) throw new GoogleIntegrationError("This sign-in link has expired or was already used. Ask Claude for a new one.", "expired");
  const state = randomToken(24);
  const verifier = randomToken(48);
  await store.set<StateRecord>(`gstate:${state}`, { connectionKey: start.connectionKey, verifier }, STATE_TTL);
  return buildAuthorizationUrl(config, state, pkceChallenge(verifier));
}

export async function completeAuthorization(state: string, code: string): Promise<{ email?: string }> {
  const { store, config, key } = dependencies();
  const record = await store.take<StateRecord>(`gstate:${state}`);
  if (!record) throw new GoogleIntegrationError("This sign-in attempt has expired. Ask Claude for a new link.", "expired");
  const pending = await store.get<StoredConnection>(record.connectionKey);
  if (!pending) throw new GoogleIntegrationError("This connection request has expired. Ask Claude for a new link.", "expired");

  const tokens = await exchangeCode(config, code, record.verifier);
  if (!tokens.refreshToken) {
    throw new GoogleIntegrationError("Google did not return long-lived access. Please try connecting again.", "api_error");
  }
  const connection: ActiveConnection = {
    status: "connected",
    createdAt: pending.createdAt,
    connectedAt: Date.now(),
    ...(tokens.email ? { email: tokens.email } : {}),
    scope: tokens.scope,
    tokens: encrypt(JSON.stringify(tokens), key),
  };
  await store.set<StoredConnection>(record.connectionKey, connection, CONNECTION_TTL);
  return tokens.email ? { email: tokens.email } : {};
}

export interface ConnectionStatus {
  status: "pending" | "connected" | "not_found";
  email?: string;
  searchConsole?: boolean;
  analytics?: boolean;
  connectedAt?: string;
}

export async function connectionStatus(connectionId: string): Promise<ConnectionStatus> {
  assertConnectionIdShape(connectionId);
  const { store } = dependencies();
  const stored = await store.get<StoredConnection>(connectionStorageKey(connectionId));
  if (!stored) return { status: "not_found" };
  if (stored.status === "pending") return { status: "pending" };
  return {
    status: "connected",
    ...(stored.email ? { email: stored.email } : {}),
    searchConsole: stored.scope.includes("webmasters"),
    analytics: stored.scope.includes("analytics"),
    connectedAt: new Date(stored.connectedAt).toISOString(),
  };
}

/** Returns a valid access token, refreshing and re-saving it when needed. */
export async function getAccessToken(connectionId: string): Promise<string> {
  assertConnectionIdShape(connectionId);
  const { store, config, key } = dependencies();
  const storageKey = connectionStorageKey(connectionId);
  const stored = await store.get<StoredConnection>(storageKey);
  if (!stored) throw new GoogleIntegrationError("No Google connection found for this ID. Run google_connect first.", "not_connected");
  if (stored.status === "pending") {
    throw new GoogleIntegrationError("Google sign-in has not been completed yet. Open the sign-in link first.", "not_connected");
  }
  let tokens = JSON.parse(decrypt(stored.tokens, key)) as GoogleTokens;
  if (tokens.expiresAt - Date.now() < 60_000) {
    if (!tokens.refreshToken) throw new GoogleIntegrationError("Google access expired. Please reconnect Google.", "expired");
    tokens = await refreshTokens(config, tokens.refreshToken);
    await store.set<StoredConnection>(storageKey, { ...stored, tokens: encrypt(JSON.stringify(tokens), key) }, CONNECTION_TTL);
  }
  return tokens.accessToken;
}

export async function disconnect(connectionId: string): Promise<boolean> {
  assertConnectionIdShape(connectionId);
  const { store, key } = dependencies();
  const storageKey = connectionStorageKey(connectionId);
  const stored = await store.get<StoredConnection>(storageKey);
  if (!stored) return false;
  if (stored.status === "connected") {
    const tokens = JSON.parse(decrypt(stored.tokens, key)) as GoogleTokens;
    await revokeToken(tokens.refreshToken ?? tokens.accessToken);
  }
  await store.del(storageKey);
  return true;
}
