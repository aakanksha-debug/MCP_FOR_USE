import { describe, expect, it } from "vitest";
import { isPublicAddress, normalizeTargetUrl, UnsafeUrlError } from "@/core/url-guard";

describe("normalizeTargetUrl", () => {
  it("adds https and strips the hash", () => {
    expect(normalizeTargetUrl("example.com/page#top").toString()).toBe("https://example.com/page");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://metadata.google.internal/",
    "https://intranet/",
    "ftp://example.com/",
    "https://user:pass@example.com/",
    "https://example.com:8080/",
    "http://printer.local/",
  ])("rejects %s", (url) => {
    expect(() => normalizeTargetUrl(url)).toThrow(UnsafeUrlError);
  });
});

describe("isPublicAddress", () => {
  it("accepts public unicast and rejects private ranges", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    expect(isPublicAddress("192.168.1.1")).toBe(false);
    expect(isPublicAddress("100.64.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("fd00::1")).toBe(false);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
});
