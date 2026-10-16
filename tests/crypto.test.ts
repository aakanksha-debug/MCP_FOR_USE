import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@/integrations/storage/crypto";

describe("token encryption", () => {
  const key = randomBytes(32);

  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("secret-token", key);
    const b = encrypt("secret-token", key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe("secret-token");
  });

  it("rejects tampered data and the wrong key", () => {
    const payload = encrypt("secret-token", key);
    const parts = payload.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), key)).toThrow();
    expect(() => decrypt(payload, randomBytes(32))).toThrow();
  });
});
