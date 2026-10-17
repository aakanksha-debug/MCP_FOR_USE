import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { allowPrivateHosts } from "@/config/env";
import { assertFetchableUrl, isPublicAddress, UnsafeUrlError } from "./url-guard";

export interface FetchOptions {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Extra request headers (for example Authorization for CMS APIs). */
  headers?: Record<string, string>;
  /** Request body; sent as-is. Redirects are not followed for requests with a body. */
  body?: string;
  /** Maximum response body to read; the rest is discarded. */
  maxBytes?: number;
  timeoutMs?: number;
  followRedirects?: boolean;
  accept?: string;
}

export interface RedirectHop {
  url: string;
  status: number;
}

export interface FetchResult {
  requestedUrl: string;
  /** URL after redirects. */
  url: string;
  /** 0 when the request failed before an HTTP response. */
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  redirects: RedirectHop[];
  body: string;
  bytes: number;
  truncated: boolean;
  timingMs: number;
  error?: string;
}

export type Fetcher = (url: string, options?: FetchOptions) => Promise<FetchResult>;

export const USER_AGENT =
  "Mozilla/5.0 (compatible; IncrementorsAuditBot/0.1; +https://www.incrementors.com/)";

const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Resolves DNS and refuses private addresses at connect time. Checking here
 * (not only before the request) also covers redirects and DNS rebinding.
 */
function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) {
  dnsLookup(hostname, { family: options.family ?? 0, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    const list = addresses as LookupAddress[];
    if (!allowPrivateHosts() && list.some((entry) => !isPublicAddress(entry.address))) {
      return callback(
        Object.assign(new UnsafeUrlError(`${hostname} resolves to a private address.`), { code: "EUNSAFE" }),
        [],
      );
    }
    if (options.all) return callback(null, list);
    const first = list[0];
    if (!first) return callback(Object.assign(new Error(`No address for ${hostname}`), { code: "ENOTFOUND" }), []);
    callback(null, first.address, first.family);
  });
}

const agent = new Agent({
  connect: { lookup: guardedLookup as never, timeout: 8_000 },
  headersTimeout: DEFAULT_TIMEOUT_MS,
  bodyTimeout: DEFAULT_TIMEOUT_MS,
  connections: 8,
});

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

function charsetOf(contentType: string | undefined): string {
  const match = contentType?.match(/charset=["']?([\w-]+)/i);
  const charset = match?.[1]?.toLowerCase() ?? "utf-8";
  try {
    new TextDecoder(charset);
    return charset;
  } catch {
    return "utf-8";
  }
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; total: number; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(), total: 0, truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, total, truncated };
}

function failure(requestedUrl: string, url: string, redirects: RedirectHop[], started: number, error: unknown): FetchResult {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof UnsafeUrlError || cause?.code === "EUNSAFE") message = cause?.message ?? message;
  else if (cause?.code) message = `${cause.code}${cause.message ? `: ${cause.message}` : ""}`;
  if (error instanceof Error && error.name === "TimeoutError") message = "Request timed out";
  return {
    requestedUrl,
    url,
    status: 0,
    ok: false,
    headers: {},
    redirects,
    body: "",
    bytes: 0,
    truncated: false,
    timingMs: Date.now() - started,
    error: message,
  };
}

/**
 * Fetches a public URL with SSRF protection, manual redirect handling, a size
 * cap and a timeout. Never throws for network problems; check `error`/`status`.
 */
export const safeFetch: Fetcher = async (input, options = {}) => {
  const method = options.method ?? "GET";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const followRedirects = (options.followRedirects ?? true) && options.body === undefined;
  const started = Date.now();
  const redirects: RedirectHop[] = [];
  let current = input;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let url: URL;
    try {
      url = new URL(current);
      assertFetchableUrl(url);
    } catch (error) {
      return failure(input, current, redirects, started, error);
    }

    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(url, {
        method,
        redirect: "manual",
        dispatcher: agent,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": USER_AGENT,
          accept: options.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en;q=0.9,*;q=0.5",
          ...(options.headers ?? {}),
        },
        ...(options.body !== undefined ? { body: options.body } : {}),
      });
    } catch (error) {
      return failure(input, url.toString(), redirects, started, error);
    }

    const location = response.headers.get("location");
    if (followRedirects && response.status >= 300 && response.status < 400 && location) {
      redirects.push({ url: url.toString(), status: response.status });
      await response.body?.cancel().catch(() => undefined);
      current = new URL(location, url).toString();
      continue;
    }

    const headers = headersToRecord(response.headers as unknown as Headers);
    let text = "";
    let total = 0;
    let truncated = false;
    if (method !== "HEAD") {
      try {
        const read = await readBody(response.body as ReadableStream<Uint8Array> | null, maxBytes);
        text = new TextDecoder(charsetOf(headers["content-type"])).decode(read.bytes);
        total = read.total;
        truncated = read.truncated;
      } catch (error) {
        return failure(input, url.toString(), redirects, started, error);
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }

    return {
      requestedUrl: input,
      url: url.toString(),
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers,
      redirects,
      body: text,
      bytes: total,
      truncated,
      timingMs: Date.now() - started,
    };
  }

  return failure(input, current, redirects, started, new Error(`Too many redirects (more than ${MAX_REDIRECTS})`));
};
