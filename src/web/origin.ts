/** Host the browser used (proxies such as Vercel pass it in x-forwarded-host). */
function requestHost(request: Request): string {
  return request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
}

/** Absolute URL on the same host the browser used, for redirects. */
export function sameHostUrl(request: Request, path: string): URL {
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return new URL(path, `${proto}://${requestHost(request)}`);
}

/** Rejects cross-site form posts (CSRF): the Origin header, when sent, must match this site. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === requestHost(request);
  } catch {
    return false;
  }
}
