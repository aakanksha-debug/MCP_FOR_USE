import { Redis } from "@upstash/redis";
import { del, get, put } from "@vercel/blob";
import { blobStorageConfig, isProductionDeployment, redisRestConfig, type BlobStorageConfig } from "@/config/env";

/** Minimal key-value store used for OAuth state and encrypted tokens. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /** Reads and deletes in one step (for one-time tokens). */
  take<T>(key: string): Promise<T | null>;
  del(key: string): Promise<void>;
}

class RedisStore implements KeyValueStore {
  constructor(private readonly redis: Redis) {}
  async get<T>(key: string) {
    return (await this.redis.get<T>(key)) ?? null;
  }
  async set<T>(key: string, value: T, ttlSeconds: number) {
    await this.redis.set(key, value, { ex: ttlSeconds });
  }
  async take<T>(key: string) {
    return (await this.redis.getdel<T>(key)) ?? null;
  }
  async del(key: string) {
    await this.redis.del(key);
  }
}

/**
 * Private Vercel Blob store: one JSON blob per key, with the expiry stored
 * alongside the value. Reads skip the CDN cache so overwrites are seen at once.
 */
export class BlobStore implements KeyValueStore {
  constructor(private readonly config: BlobStorageConfig = {}) {}
  private pathname(key: string) {
    return `kv/${key.split(":").map(encodeURIComponent).join("/")}.json`;
  }
  async get<T>(key: string) {
    const result = await get(this.pathname(key), { access: "private", useCache: false, token: this.config.token });
    if (!result || result.statusCode !== 200) return null;
    const entry = JSON.parse(await new Response(result.stream).text()) as { value: T; expires: number };
    if (entry.expires < Date.now()) {
      await this.del(key);
      return null;
    }
    return entry.value;
  }
  async set<T>(key: string, value: T, ttlSeconds: number) {
    await put(this.pathname(key), JSON.stringify({ value, expires: Date.now() + ttlSeconds * 1000 }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 60,
      token: this.config.token,
    });
  }
  async take<T>(key: string) {
    const value = await this.get<T>(key);
    if (value !== null) await this.del(key);
    return value;
  }
  async del(key: string) {
    await del(this.pathname(key), { token: this.config.token });
  }
}

/** Process-local store for local development. Does not survive restarts or span serverless instances. */
export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, { value: unknown; expires: number }>();
  async get<T>(key: string) {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      this.data.delete(key);
      return null;
    }
    return structuredClone(entry.value) as T;
  }
  async set<T>(key: string, value: T, ttlSeconds: number) {
    this.data.set(key, { value: structuredClone(value), expires: Date.now() + ttlSeconds * 1000 });
  }
  async take<T>(key: string) {
    const value = await this.get<T>(key);
    this.data.delete(key);
    return value;
  }
  async del(key: string) {
    this.data.delete(key);
  }
}

const globalStore = globalThis as unknown as { __incrementorsMemoryStore?: MemoryStore };

/**
 * Redis when configured, else a private Vercel Blob store; an in-memory store
 * for local development; otherwise null (publishing and Google features then
 * report that storage is not configured).
 */
export function getStore(): KeyValueStore | null {
  const redis = redisRestConfig();
  if (redis) return new RedisStore(new Redis({ url: redis.url, token: redis.token }));
  const blob = blobStorageConfig();
  if (blob) return new BlobStore(blob);
  if (isProductionDeployment() || process.env.VERCEL) return null;
  globalStore.__incrementorsMemoryStore ??= new MemoryStore();
  return globalStore.__incrementorsMemoryStore;
}
