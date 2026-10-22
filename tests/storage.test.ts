import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const blobs = new Map<string, string>();

vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (pathname: string, body: string, options: { access: string; allowOverwrite?: boolean }) => {
    expect(options.access).toBe("private");
    expect(options.allowOverwrite).toBe(true);
    blobs.set(pathname, body);
    return { pathname };
  }),
  get: vi.fn(async (pathname: string, options: { access: string; useCache?: boolean }) => {
    expect(options).toMatchObject({ access: "private", useCache: false });
    const body = blobs.get(pathname);
    return body === undefined ? null : { statusCode: 200, stream: new Response(body).body };
  }),
  del: vi.fn(async (pathname: string) => {
    blobs.delete(pathname);
  }),
}));

describe("Blob key-value store", () => {
  beforeEach(() => {
    blobs.clear();
    vi.resetModules();
    vi.stubEnv("KV_REST_API_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
    vi.stubEnv("VERCEL", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("is used on Vercel when a Blob store is connected and Redis is not", async () => {
    const { BlobStore, getStore } = await import("@/integrations/storage/kv");
    expect(getStore()).toBeInstanceOf(BlobStore);
  });

  it("stores, overwrites, takes and deletes values under private paths", async () => {
    const { getStore } = await import("@/integrations/storage/kv");
    const store = getStore()!;
    await store.set("site:abc", { host: "example.com" }, 60);
    expect([...blobs.keys()]).toEqual(["kv/site/abc.json"]);
    expect(await store.get("site:abc")).toEqual({ host: "example.com" });

    await store.set("site:abc", { host: "example.org" }, 60);
    expect(await store.take("site:abc")).toEqual({ host: "example.org" });
    expect(await store.get("site:abc")).toBeNull();

    await store.set("approval:x", 1, 60);
    await store.del("approval:x");
    expect(blobs.size).toBe(0);
  });

  it("treats expired values as missing and removes them", async () => {
    const { getStore } = await import("@/integrations/storage/kv");
    const store = getStore()!;
    vi.useFakeTimers();
    await store.set("gstart:token", "value", 60);
    vi.advanceTimersByTime(61_000);
    expect(await store.get("gstart:token")).toBeNull();
    expect(blobs.size).toBe(0);
  });

  it("still prefers Redis when both are configured", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://redis.example.test");
    vi.stubEnv("KV_REST_API_TOKEN", "token");
    const { BlobStore, getStore } = await import("@/integrations/storage/kv");
    expect(getStore()).not.toBeInstanceOf(BlobStore);
  });
});
