import { BRAND } from "@/config/brand";

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PRODUCT = "Incrementors Website Audit";

const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
} as const;

const CLAUDE_HOSTS = new Set(["claude.ai", "claude.com"]);

/** Where the user returns after signing in, flagged when it is not Claude (any client can register). */
function returnLine(redirectUri: string): string {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return "";
  }
  const host = url.host || url.protocol;
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (CLAUDE_HOSTS.has(url.hostname) || url.hostname.endsWith(".claude.ai")) return `<p class="hint">After signing in you return to ${escape(host)}.</p>`;
  if (local) return `<p class="hint">After signing in you return to an app on this computer (${escape(host)}).</p>`;
  return `<p class="notice">After signing in you will be sent to <strong>${escape(host)}</strong>, which is not Claude. Only continue if you started this from an app you trust.</p>`;
}

/** The page shown while adding the connector: sign in with Google, or continue without it. */
export function authorizePage(options: {
  requestId: string;
  clientName?: string;
  redirectUri: string;
  googleAvailable: boolean;
  notice?: string;
}): Response {
  const client = escape(options.clientName?.trim() || "Claude");
  const notice = options.notice ? `<p class="notice">${escape(options.notice)}</p>` : "";
  const google = options.googleAvailable
    ? `<button class="primary" type="submit" name="action" value="google">Sign in with Google</button>
       <ul>
         <li>Your Search Console and Google Analytics data is added to every audit automatically.</li>
         <li>Read-only: nothing in your Google account can be changed.</li>
         <li>Disconnect any time by asking Claude, or at myaccount.google.com/permissions.</li>
       </ul>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect ${PRODUCT}</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f5; --card: #fff; --text: #1d1d1b; --muted: #5c5c57; --accent: #1f5fbf; --line: #e2e2dc; --warn: #8a5a00; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #22221f; --text: #ededea; --muted: #a8a8a2; --accent: #6ea2f0; --line: #3a3a35; --warn: #e0b45c; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; padding: 16px; }
  main { width: 100%; max-width: 460px; background: var(--card); border-radius: 12px; padding: 28px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.12); }
  h1 { margin: 0 0 6px; font-size: 21px; }
  p { margin: 0 0 16px; color: var(--muted); }
  ul { margin: 12px 0 20px; padding-left: 20px; color: var(--muted); font-size: 14px; }
  button { width: 100%; font: inherit; border-radius: 8px; padding: 11px 14px; cursor: pointer; }
  .primary { background: var(--accent); color: #fff; border: 0; font-weight: 600; }
  .secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
  .hint { font-size: 13px; margin: 8px 0 0; }
  .notice { color: var(--warn); font-size: 14px; }
  footer { margin-top: 20px; font-size: 13px; color: var(--muted); }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Connect ${PRODUCT}</h1>
  <p>${client} wants to use the free website audit tools (SEO, AEO, GEO, technical, schema, conversion and content).</p>
  ${notice}
  ${returnLine(options.redirectUri)}
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="request" value="${escape(options.requestId)}">
    ${google}
    <button class="secondary" type="submit" name="action" value="skip">Continue without Google</button>
    <p class="hint">Website audits work either way. You can connect Google later in the chat.</p>
  </form>
  <footer><a href="/privacy" target="_blank" rel="noopener">Privacy</a> · by ${escape(BRAND.name)}</footer>
</main>
</body>
</html>`;
  return new Response(html, { status: 200, headers: SECURITY_HEADERS });
}
