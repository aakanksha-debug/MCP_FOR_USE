import { googleOAuthConfig, publicBaseUrl, tokenEncryptionKey, type GoogleOAuthConfig } from "@/config/env";
import { decrypt, encrypt, hashKey, pkceChallenge, randomToken } from "../storage/crypto";
import { getStore, type KeyValueStore } from "../storage/kv";
import { GoogleIntegrationError } from "./errors";
import {
  buildAuthorizationUrl,
  exchangeCode,
  grantedServices,
  refreshTokens,
  revokeToken,
  scopesFor,
  type GoogleService,
  type GoogleTokens,
} from "./oauth";

/**
 * Connection lifecycle for the optional Google sign-in.
 *
 * Two ways in: signing in with Google while adding the connector (the
 * connection ID then travels inside the connector's access token), or
 * `google_connect` later in a conversation, which creates a random connection
 * ID and a one-time sign-in link. Either way the encrypted tokens are stored
 * under a hash of that ID. Only read-only scopes are requested, and
 * `google_disconnect` revokes access.
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
  scopes: string[];
}

interface StateRecord {
  connectionKey: string;
  verifier: string;
  /** Set when Google sign-in happens while adding the connector. */
  login?: { requestId: string; connection: string };
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
    console.warn(
      `[google] Sign-in requested but not configured. Create a Google OAuth web client with redirect URI ${publicBaseUrl()}/api/google/callback and set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY (see docs/DEPLOYMENT.md).`,
    );
    throw new GoogleIntegrationError(
      "Connecting Google Search Console and Analytics isn't available on this server yet. Your audit results are complete without it; the Google check only adds traffic and conversion data on top. (Server admin: the redirect URI to register is " +
        `${publicBaseUrl()}/api/google/callback.)`,
      "not_configured",
    );
  }
  const store = getStore();
  if (!store) {
    console.warn("[google] Sign-in requested but no storage is configured (connect a private Vercel Blob store or Upstash Redis).");
    throw new GoogleIntegrationError(
      "Connecting Google Search Console and Analytics isn't available on this server yet. Your audit results are complete without it. (Server admin: connect a private Vercel Blob store or Upstash Redis to the project.)",
      "storage_unavailable",
    );
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

/**
 * Starts a Google sign-in for the given services. Passing an existing
 * connectionId adds services to that connection (incremental consent), so the
 * user connects Search Console first and Analytics later with the same ID.
 */
export async function createConnection(
  services: GoogleService[] = ["search_console"],
  existingConnectionId?: string,
): Promise<{ connectionId: string; signInUrl: string; expiresInMinutes: number; adding: boolean }> {
  const { store } = dependencies();
  let connectionId: string;
  let connectionKey: string;
  let adding = false;
  let alreadyGranted: GoogleService[] = [];

  if (existingConnectionId) {
    assertConnectionIdShape(existingConnectionId);
    const stored = await store.get<StoredConnection>(connectionStorageKey(existingConnectionId));
    if (!stored || stored.status !== "connected") {
      throw new GoogleIntegrationError("That Google connection was not found or is not finished. Start a new one with google_connect.", "not_connected");
    }
    connectionId = existingConnectionId;
    connectionKey = connectionStorageKey(existingConnectionId);
    alreadyGranted = grantedServices(stored.scope);
    adding = true;
  } else {
    connectionId = `${CONNECTION_ID_PREFIX}${randomToken(32)}`;
    connectionKey = connectionStorageKey(connectionId);
    await store.set<StoredConnection>(connectionKey, { status: "pending", createdAt: Date.now() }, PENDING_TTL);
  }

  const startToken = randomToken(24);
  const wanted = [...new Set([...alreadyGranted, ...services])];
  await store.set<StartRecord>(`gstart:${startToken}`, { connectionKey, scopes: scopesFor(wanted) }, PENDING_TTL);
  return {
    connectionId,
    signInUrl: `${publicBaseUrl()}/api/google/connect?start=${encodeURIComponent(startToken)}`,
    expiresInMinutes: PENDING_TTL / 60,
    adding,
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
  return buildAuthorizationUrl(config, state, pkceChallenge(verifier), start.scopes ?? scopesFor(["search_console", "analytics"]));
}

/**
 * Starts the Google sign-in shown while adding the connector: Search Console
 * and Analytics in one consent. Returns Google's consent URL.
 */
export async function beginLoginAuthorization(requestId: string): Promise<string> {
  const { store, config, key } = dependencies();
  const connectionId = `${CONNECTION_ID_PREFIX}${randomToken(32)}`;
  const connectionKey = connectionStorageKey(connectionId);
  await store.set<StoredConnection>(connectionKey, { status: "pending", createdAt: Date.now() }, PENDING_TTL);
  const state = randomToken(24);
  const verifier = randomToken(48);
  await store.set<StateRecord>(`gstate:${state}`, { connectionKey, verifier, login: { requestId, connection: encrypt(connectionId, key) } }, STATE_TTL);
  return buildAuthorizationUrl(config, state, pkceChallenge(verifier), scopesFor(["search_console", "analytics"]));
}

/** When Google sign-in is cancelled: forgets the attempt and returns the connector request to go back to, if any. */
export async function abandonAuthorization(state: string): Promise<string | undefined> {
  const store = getStore();
  if (!store || !/^[A-Za-z0-9_-]{20,64}$/.test(state)) return undefined;
  const record = await store.take<StateRecord>(`gstate:${state}`);
  return record?.login?.requestId;
}

export async function completeAuthorization(
  state: string,
  code: string,
): Promise<{ email?: string; login?: { requestId: string; connectionId: string } }> {
  const { store, config, key } = dependencies();
  const record = await store.take<StateRecord>(`gstate:${state}`);
  if (!record) throw new GoogleIntegrationError("This sign-in attempt has expired. Ask Claude for a new link.", "expired");
  const pending = await store.get<StoredConnection>(record.connectionKey);
  if (!pending) throw new GoogleIntegrationError("This connection request has expired. Ask Claude for a new link.", "expired");

  const exchanged = await exchangeCode(config, code, record.verifier);
  // When adding a service, Google may not send a new refresh token; keep the existing one.
  const previous = pending.status === "connected" ? (JSON.parse(decrypt(pending.tokens, key)) as GoogleTokens) : undefined;
  const tokens: GoogleTokens = exchanged.refreshToken || !previous?.refreshToken ? exchanged : { ...exchanged, refreshToken: previous.refreshToken };
  if (!tokens.refreshToken) {
    throw new GoogleIntegrationError("Google did not return long-lived access. Please try connecting again.", "api_error");
  }
  const email = tokens.email ?? (pending.status === "connected" ? pending.email : undefined);
  const connection: ActiveConnection = {
    status: "connected",
    createdAt: pending.createdAt,
    connectedAt: Date.now(),
    ...(email ? { email } : {}),
    scope: tokens.scope,
    tokens: encrypt(JSON.stringify(tokens), key),
  };
  await store.set<StoredConnection>(record.connectionKey, connection, CONNECTION_TTL);
  const login = record.login ? { requestId: record.login.requestId, connectionId: decrypt(record.login.connection, key) } : undefined;
  return { ...(email ? { email } : {}), ...(login ? { login } : {}) };
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

const SERVICE_LABEL: Record<GoogleService, string> = { search_console: "Search Console", analytics: "Google Analytics" };

/**
 * Returns a valid access token, refreshing and re-saving it when needed. With
 * `requires`, fails with a clear next step if that service was not granted.
 */
export async function getAccessToken(connectionId: string, requires?: GoogleService): Promise<string> {
  assertConnectionIdShape(connectionId);
  const { store, config, key } = dependencies();
  const storageKey = connectionStorageKey(connectionId);
  const stored = await store.get<StoredConnection>(storageKey);
  if (!stored) throw new GoogleIntegrationError("No Google connection found for this ID. Run google_connect first.", "not_connected");
  if (stored.status === "pending") {
    throw new GoogleIntegrationError("Google sign-in has not been completed yet. Open the sign-in link first.", "not_connected");
  }
  if (requires && !grantedServices(stored.scope).includes(requires)) {
    throw new GoogleIntegrationError(
      `${SERVICE_LABEL[requires]} isn't connected yet. Call google_connect with services ["${requires}"] and this connectionId to add it (one more read-only Google consent).`,
      "not_connected",
    );
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
