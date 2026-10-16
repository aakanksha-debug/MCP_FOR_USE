import ipaddr from "ipaddr.js";
import { allowPrivateHosts } from "@/config/env";

/**
 * Server-side request forgery protection. Audits fetch user-supplied URLs, so
 * every hostname and resolved IP must be public before we connect.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".corp"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal"]);

/** True for globally routable unicast addresses only. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

/**
 * Normalizes a user-supplied URL ("example.com" becomes "https://example.com/")
 * and rejects anything that is not a public http(s) URL.
 */
export function normalizeTargetUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new UnsafeUrlError("Please provide a website URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UnsafeUrlError(`"${input}" is not a valid URL.`);
  }
  assertFetchableUrl(url);
  url.hash = "";
  return url;
}

export function assertFetchableUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Only http and https URLs can be audited.");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("URLs with embedded credentials are not allowed.");
  }
  if (allowPrivateHosts()) return;

  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new UnsafeUrlError("Only standard web ports (80 and 443) can be audited.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UnsafeUrlError("Local and internal hostnames cannot be audited.");
  }
  if (ipaddr.isValid(host)) {
    if (!isPublicAddress(host)) throw new UnsafeUrlError("Private or reserved IP addresses cannot be audited.");
  } else if (!host.includes(".")) {
    throw new UnsafeUrlError("Please use a full public domain name.");
  }
}
