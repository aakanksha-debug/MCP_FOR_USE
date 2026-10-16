const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Minimal standalone page for OAuth results (shown in the user's browser). */
export function messagePage(title: string, message: string, ok: boolean, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f5; --card: #fff; --text: #1d1d1b; --muted: #5c5c57; --accent: ${ok ? "#1f7a4d" : "#a33a2b"}; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #22221f; --text: #ededea; --muted: #a8a8a2; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; padding: 16px; }
  main { max-width: 440px; background: var(--card); border-radius: 12px; padding: 28px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.12); }
  h1 { margin: 0 0 8px; font-size: 20px; color: var(--accent); }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" },
  });
}
