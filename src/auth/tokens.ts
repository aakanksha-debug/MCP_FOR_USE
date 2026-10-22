import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { tokenEncryptionKey } from "@/config/env";
import { decrypt, encrypt } from "@/integrations/storage/crypto";

/**
 * Sealed (encrypted and authenticated) tokens for the connector sign-in.
 * Client IDs, access tokens and refresh tokens carry their own data, so they
 * need no storage. Keys are derived from TOKEN_ENCRYPTION_KEY per purpose, so
 * no extra secret has to be configured.
 */

function derivedKey(purpose: "seal" | "sign"): Buffer {
  const base = tokenEncryptionKey();
  if (!base) throw new Error("TOKEN_ENCRYPTION_KEY is not configured.");
  return Buffer.from(hkdfSync("sha256", base, Buffer.alloc(0), `incrementors-mcp-auth:${purpose}`, 32));
}

export function seal(prefix: string, payload: object): string {
  return `${prefix}${encrypt(JSON.stringify(payload), derivedKey("seal"))}`;
}

/** Returns null for anything that was not sealed by this server with this prefix. */
export function unseal<T>(prefix: string, token: string | null | undefined): T | null {
  if (!token?.startsWith(prefix)) return null;
  try {
    return JSON.parse(decrypt(token.slice(prefix.length), derivedKey("seal"))) as T;
  } catch {
    return null;
  }
}

export function sign(value: string): string {
  return createHmac("sha256", derivedKey("sign")).update(value).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
