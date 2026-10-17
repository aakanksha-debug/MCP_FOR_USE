import { allowPrivateHosts, publicBaseUrl, tokenEncryptionKey } from "@/config/env";
import type { Fetcher } from "@/core/http";
import { normalizeTargetUrl } from "@/core/url-guard";
import { decrypt, encrypt, hashKey, randomToken } from "@/integrations/storage/crypto";
import { getStore, type KeyValueStore } from "@/integrations/storage/kv";
import { createAdapter, PUBLISHING_PLATFORMS, type PlatformCredentials } from "./index";
import { PlatformError, type PlatformAdapter, type PlatformId, type SiteIdentity } from "./types";

/**
 * Website connections for publishing approved fixes.
 *
 * Claude asks the user first, then `connect_website` creates a connection ID
 * (kept in the conversation) and a one-time link. The site owner enters CMS
 * credentials on that page, never in the chat, and gives explicit consent.
 * Credentials are verified, bound to the audited domain, encrypted and kept
 * for 30 days under a hash of the connection ID.
 */

const PENDING_TTL = 30 * 60;
const CONNECTION_TTL = 30 * 24 * 60 * 60;
const CONNECTION_ID_PREFIX = "site_";

interface PendingSite {
  status: "pending";
  host: string;
  createdAt: number;
}

interface ConnectedSite {
  status: "connected";
  host: string;
  platform: PlatformId;
  siteName?: string;
  user?: string;
  connectedAt: number;
  credentials: string;
}

type StoredSite = PendingSite | ConnectedSite;

interface ConnectTokenRecord {
  connectionKey: string;
  host: string;
}

function dependencies(): { store: KeyValueStore; key: Buffer } {
  const key = tokenEncryptionKey();
  const store = getStore();
  if (!key || !store) {
    throw new PlatformError(
      "Publishing fixes to websites is not configured on this server yet (it needs TOKEN_ENCRYPTION_KEY and Redis storage). Prepared fixes can still be applied by hand.",
    );
  }
  return { store, key };
}

export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

const storageKey = (connectionId: string) => `site:${hashKey(connectionId)}`;

function assertIdShape(connectionId: string): void {
  if (!connectionId.startsWith(CONNECTION_ID_PREFIX) || connectionId.length < 40) {
    throw new PlatformError("That website connection ID is not valid. Run connect_website to create a new one.");
  }
}

export async function createSiteConnection(url: string): Promise<{ connectionId: string; connectUrl: string; host: string; expiresInMinutes: number }> {
  const { store } = dependencies();
  const host = normalizeTargetUrl(url).hostname;
  const connectionId = `${CONNECTION_ID_PREFIX}${randomToken(32)}`;
  const token = randomToken(24);
  await store.set<StoredSite>(storageKey(connectionId), { status: "pending", host, createdAt: Date.now() }, PENDING_TTL);
  await store.set<ConnectTokenRecord>(`siteconnect:${token}`, { connectionKey: storageKey(connectionId), host }, PENDING_TTL);
  return { connectionId, connectUrl: `${publicBaseUrl()}/connect/${token}`, host, expiresInMinutes: PENDING_TTL / 60 };
}

/** For rendering the connect page: which site the link is for, or null if expired/used. */
export async function readConnectToken(token: string): Promise<{ host: string } | null> {
  const { store } = dependencies();
  const record = await store.get<ConnectTokenRecord>(`siteconnect:${token}`);
  return record ? { host: record.host } : null;
}

/** Verifies credentials against the site, checks the domain, and stores them encrypted. */
export async function completeSiteConnection(token: string, credentials: PlatformCredentials, fetcher?: Fetcher): Promise<SiteIdentity> {
  const { store, key } = dependencies();
  const record = await store.get<ConnectTokenRecord>(`siteconnect:${token}`);
  if (!record) throw new PlatformError("This connection link has expired or was already used. Ask Claude for a new one.");

  const siteUrl = normalizeTargetUrl(credentials.siteUrl);
  // Plain HTTP is only accepted in local development (never on a production deployment).
  if (siteUrl.protocol !== "https:" && !allowPrivateHosts()) {
    throw new PlatformError("The site must use HTTPS so your password is never sent unencrypted.");
  }
  if (bareHost(siteUrl.hostname) !== bareHost(record.host)) {
    throw new PlatformError(`This link is for ${record.host}. Connect that website, not ${siteUrl.hostname}.`);
  }

  const identity = await createAdapter({ ...credentials, siteUrl: siteUrl.toString() }, fetcher).verify();
  let reportedHost: string;
  try {
    reportedHost = new URL(identity.siteUrl).hostname;
  } catch {
    reportedHost = siteUrl.hostname;
  }
  if (bareHost(reportedHost) !== bareHost(record.host)) {
    throw new PlatformError(`These credentials belong to ${reportedHost}, not ${record.host}.`);
  }

  const connected: ConnectedSite = {
    status: "connected",
    host: record.host,
    platform: credentials.platform,
    ...(identity.siteName ? { siteName: identity.siteName } : {}),
    ...(identity.user ? { user: identity.user } : {}),
    connectedAt: Date.now(),
    credentials: encrypt(JSON.stringify({ ...credentials, siteUrl: siteUrl.toString() }), key),
  };
  await store.set<StoredSite>(record.connectionKey, connected, CONNECTION_TTL);
  await store.del(`siteconnect:${token}`);
  return identity;
}

export interface SiteConnectionStatus {
  status: "pending" | "connected" | "not_found";
  host?: string;
  platform?: string;
  siteName?: string;
  user?: string;
  connectedAt?: string;
}

export async function siteConnectionStatus(connectionId: string): Promise<SiteConnectionStatus> {
  assertIdShape(connectionId);
  const { store } = dependencies();
  const stored = await store.get<StoredSite>(storageKey(connectionId));
  if (!stored) return { status: "not_found" };
  if (stored.status === "pending") return { status: "pending", host: stored.host };
  return {
    status: "connected",
    host: stored.host,
    platform: PUBLISHING_PLATFORMS[stored.platform],
    ...(stored.siteName ? { siteName: stored.siteName } : {}),
    ...(stored.user ? { user: stored.user } : {}),
    connectedAt: new Date(stored.connectedAt).toISOString(),
  };
}

export interface LoadedSite {
  connectionKey: string;
  host: string;
  platformLabel: string;
  siteName?: string;
  adapter: PlatformAdapter;
}

/** Loads a connected site by its storage key (used by approval pages, which never see the raw ID). */
export async function loadSiteByKey(connectionKey: string, fetcher?: Fetcher): Promise<LoadedSite> {
  const { store, key } = dependencies();
  const stored = await store.get<StoredSite>(connectionKey);
  if (!stored || stored.status !== "connected") {
    throw new PlatformError("The website is no longer connected. Ask Claude to connect it again before publishing.");
  }
  const credentials = JSON.parse(decrypt(stored.credentials, key)) as PlatformCredentials;
  return {
    connectionKey,
    host: stored.host,
    platformLabel: PUBLISHING_PLATFORMS[stored.platform],
    ...(stored.siteName ? { siteName: stored.siteName } : {}),
    adapter: createAdapter(credentials, fetcher),
  };
}

export async function loadSite(connectionId: string, fetcher?: Fetcher): Promise<LoadedSite> {
  assertIdShape(connectionId);
  return loadSiteByKey(storageKey(connectionId), fetcher);
}

export async function disconnectSite(connectionId: string): Promise<boolean> {
  assertIdShape(connectionId);
  const { store } = dependencies();
  const key = storageKey(connectionId);
  const existed = Boolean(await store.get<StoredSite>(key));
  await store.del(key);
  return existed;
}
