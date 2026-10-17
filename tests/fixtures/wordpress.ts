import type { Fetcher, FetchResult } from "@/core/http";

/** In-memory WordPress REST API, enough for the adapter's calls. */
export interface FakeWordPress {
  fetcher: Fetcher;
  pages: Map<number, { id: number; slug: string; link: string; raw: string }>;
  media: Map<number, { id: number; source_url: string; alt_text: string }>;
  writes: string[];
}

export function fakeWordPress(options: { base: string; username: string; password: string; editor?: boolean }): FakeWordPress {
  const auth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
  const pages = new Map<number, { id: number; slug: string; link: string; raw: string }>();
  const media = new Map<number, { id: number; source_url: string; alt_text: string }>();
  const writes: string[] = [];

  const respond = (url: string, status: number, data: unknown): FetchResult => ({
    requestedUrl: url,
    url,
    status,
    ok: status >= 200 && status < 300,
    headers: { "content-type": "application/json" },
    redirects: [],
    body: JSON.stringify(data),
    bytes: 0,
    truncated: false,
    timingMs: 5,
  });
  const pageJson = (page: { id: number; link: string; raw: string }) => ({ id: page.id, link: page.link, content: { raw: page.raw } });

  const fetcher: Fetcher = async (url, init = {}) => {
    if (!url.startsWith(`${options.base}/wp-json`)) return respond(url, 404, { code: "rest_no_route" });
    if (init.headers?.authorization !== auth) return respond(url, 401, { code: "rest_not_logged_in", message: "Not logged in" });
    const parsed = new URL(url);
    const route = parsed.pathname.slice(new URL(options.base).pathname.replace(/\/$/, "").length + "/wp-json".length) || "/";
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(init.body) as Record<string, string>) : {};

    if (route === "/") return respond(url, 200, { name: "Acme Plumbing", home: options.base });
    if (route === "/wp/v2/users/me") {
      return respond(url, 200, { name: "Owner", capabilities: options.editor === false ? { read: true } : { edit_posts: true, edit_pages: true } });
    }
    if (route === "/wp/v2/settings") return respond(url, 200, { show_on_front: "page", page_on_front: 10 });
    if (route === "/wp/v2/pages" || route === "/wp/v2/posts") {
      if (route === "/wp/v2/posts") return respond(url, 200, []);
      const slug = parsed.searchParams.get("slug");
      return respond(url, 200, [...pages.values()].filter((page) => page.slug === slug).map(pageJson));
    }
    const pageMatch = route.match(/^\/wp\/v2\/pages\/(\d+)$/);
    if (pageMatch) {
      const page = pages.get(Number(pageMatch[1]));
      if (!page) return respond(url, 404, { message: "Invalid post ID." });
      if (method === "POST") {
        page.raw = body.content ?? page.raw;
        writes.push(`page:${page.id}`);
      }
      return respond(url, 200, pageJson(page));
    }
    if (route === "/wp/v2/media") {
      const search = (parsed.searchParams.get("search") ?? "").toLowerCase();
      return respond(url, 200, [...media.values()].filter((item) => item.source_url.toLowerCase().includes(search)));
    }
    const mediaMatch = route.match(/^\/wp\/v2\/media\/(\d+)$/);
    if (mediaMatch) {
      const item = media.get(Number(mediaMatch[1]));
      if (!item) return respond(url, 404, { message: "Invalid media ID." });
      if (method === "POST") {
        item.alt_text = body.alt_text ?? item.alt_text;
        writes.push(`media:${item.id}`);
      }
      return respond(url, 200, item);
    }
    return respond(url, 404, { code: "rest_no_route", message: "No route" });
  };

  return { fetcher, pages, media, writes };
}
