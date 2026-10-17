import { safeFetch, type Fetcher } from "@/core/http";
import { applyContentOp, imageKey, pathOf, setImgAlt, replaceHref, wrapTel } from "./content-ops";
import {
  PlatformError,
  type ChangeOp,
  type ChangeRequest,
  type ChangeTarget,
  type PlanResult,
  type PlatformAdapter,
  type SiteIdentity,
  type Snapshot,
} from "./types";

/**
 * WordPress through its built-in REST API, authenticated with an Application
 * Password (Users → Profile → Application Passwords). No plugin is needed or
 * installed. Only post/page content and Media Library alt text are edited.
 */

export interface WordPressCredentials {
  platform: "wordpress";
  siteUrl: string;
  username: string;
  appPassword: string;
}

interface WpPost {
  id: number;
  link: string;
  content?: { raw?: string };
}

interface WpMedia {
  id: number;
  source_url: string;
  alt_text?: string;
  media_details?: { sizes?: Record<string, { source_url: string }> };
}

const SEO_PLUGIN_REASON =
  "WordPress keeps SEO titles and descriptions in your SEO plugin (Yoast, Rank Math or All in One SEO), which can't be edited remotely without installing an extra plugin. Paste the suggested text into the plugin's fields on this page.";

function samePath(a: string, b: string): boolean {
  return pathOf(a).replace(/\/+$/, "") === pathOf(b).replace(/\/+$/, "");
}

function fileName(src: string): string {
  return pathOf(src).split("/").pop() ?? src;
}

export class WordPressAdapter implements PlatformAdapter {
  readonly platform = "wordpress" as const;
  readonly label = "WordPress";
  private readonly base: string;
  private readonly authorization: string;

  constructor(
    credentials: WordPressCredentials,
    private readonly fetcher: Fetcher = safeFetch,
  ) {
    this.base = credentials.siteUrl.replace(/\/+$/, "");
    const password = credentials.appPassword.replace(/\s+/g, "");
    this.authorization = `Basic ${Buffer.from(`${credentials.username}:${password}`).toString("base64")}`;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const result = await this.fetcher(`${this.base}/wp-json${path}`, {
      method,
      accept: "application/json",
      headers: {
        authorization: this.authorization,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 20_000,
    });
    if (result.status === 0) throw new PlatformError(`Could not reach ${this.base}${result.error ? ` (${result.error})` : ""}.`);

    let data: unknown;
    try {
      data = JSON.parse(result.body);
    } catch {
      throw new PlatformError(`${this.base} did not answer like a WordPress site (HTTP ${result.status}). Is this the right address?`);
    }
    if (!result.ok) {
      const message = (data as { message?: string; code?: string })?.message;
      if (result.status === 401) {
        throw new PlatformError(
          "WordPress rejected the username or application password. If both are correct, the hosting may be blocking the Authorization header.",
        );
      }
      if (result.status === 403) throw new PlatformError(message ?? "This WordPress user is not allowed to edit this content.");
      if (result.status === 404) throw new PlatformError(message ?? "The WordPress REST API was not found at this address.");
      throw new PlatformError(message ?? `WordPress returned HTTP ${result.status}.`);
    }
    return data as T;
  }

  async verify(): Promise<SiteIdentity> {
    const root = await this.request<{ name?: string; home?: string; url?: string }>("GET", "/");
    const me = await this.request<{ name?: string; capabilities?: Record<string, boolean> }>("GET", "/wp/v2/users/me?context=edit");
    const capabilities = me.capabilities ?? {};
    if (!capabilities.edit_posts && !capabilities.edit_pages) {
      throw new PlatformError("This WordPress user cannot edit pages or posts. Use an Editor or Administrator account.");
    }
    return {
      siteUrl: root.home ?? root.url ?? this.base,
      ...(root.name ? { siteName: root.name } : {}),
      ...(me.name ? { user: me.name } : {}),
    };
  }

  /** Finds the page or post behind a public URL, with its raw (editable) content. */
  private async findPost(pageUrl: string): Promise<{ target: ChangeTarget & { kind: "wp-post" }; raw: string } | null> {
    const path = pathOf(pageUrl).split("?")[0]!.replace(/\/+$/, "");
    if (!path) {
      try {
        const settings = await this.request<{ show_on_front?: string; page_on_front?: number }>("GET", "/wp/v2/settings");
        if (settings.show_on_front === "page" && settings.page_on_front) {
          const post = await this.request<WpPost>("GET", `/wp/v2/pages/${settings.page_on_front}?context=edit&_fields=id,link,content`);
          return { target: { kind: "wp-post", type: "pages", id: post.id, link: post.link }, raw: post.content?.raw ?? "" };
        }
      } catch {
        // Reading the front-page setting needs an administrator; fall through.
      }
      return null;
    }
    const slug = decodeURIComponent(path.split("/").pop() ?? "");
    for (const type of ["pages", "posts"] as const) {
      const items = await this.request<WpPost[]>(
        "GET",
        `/wp/v2/${type}?slug=${encodeURIComponent(slug)}&context=edit&_fields=id,link,content`,
      );
      const match = items.find((item) => samePath(item.link, pageUrl)) ?? (items.length === 1 ? items[0] : undefined);
      if (match) return { target: { kind: "wp-post", type, id: match.id, link: match.link }, raw: match.content?.raw ?? "" };
    }
    return null;
  }

  private async findMedia(src: string): Promise<WpMedia | null> {
    const stem = fileName(src).replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "").replace(/\.[a-z0-9]+$/i, "");
    if (!stem) return null;
    const items = await this.request<WpMedia[]>(
      "GET",
      `/wp/v2/media?search=${encodeURIComponent(stem)}&per_page=20&context=edit&_fields=id,source_url,alt_text,media_details`,
    );
    const key = imageKey(src);
    return (
      items.find(
        (item) =>
          imageKey(item.source_url) === key ||
          Object.values(item.media_details?.sizes ?? {}).some((size) => imageKey(size.source_url) === key),
      ) ?? null
    );
  }

  async plan(requests: ChangeRequest[]): Promise<PlanResult> {
    const result: PlanResult = { planned: [], manual: [] };
    const posts = new Map<string, ReturnType<WordPressAdapter["findPost"]>>();
    const postFor = (url: string) => {
      const key = pathOf(url);
      if (!posts.has(key)) posts.set(key, this.findPost(url));
      return posts.get(key)!;
    };
    const seen = new Set<string>();
    const add = (entry: PlanResult["planned"][number]) => {
      const key = JSON.stringify([entry.target.kind, entry.target.id, entry.op]);
      if (!seen.has(key)) {
        seen.add(key);
        result.planned.push(entry);
      }
    };

    for (const request of requests) {
      if (request.kind === "seo-title" || request.kind === "meta-description") {
        result.manual.push({ request, reason: SEO_PLUGIN_REASON });
        continue;
      }
      const post = await postFor(request.pageUrl);
      const page = pathOf(request.pageUrl);

      if (request.kind === "image-alt") {
        let planned = false;
        if (post && setImgAlt(post.raw, request.src, request.alt) !== null) {
          add({
            request,
            target: post.target,
            op: { type: "set-img-alt", src: request.src, alt: request.alt },
            label: `Image alt text on ${page} (${fileName(request.src)})`,
            before: "(no alt text)",
            after: request.alt,
          });
          planned = true;
        }
        const media = await this.findMedia(request.src);
        if (media && !media.alt_text?.trim()) {
          add({
            request,
            target: { kind: "wp-media", id: media.id, sourceUrl: media.source_url },
            op: { type: "set-alt-text", value: request.alt },
            label: `Media Library alt text for ${fileName(media.source_url)}`,
            before: "(empty)",
            after: request.alt,
          });
          planned = true;
        }
        if (!planned) {
          result.manual.push({
            request,
            reason: "This image is not in the page content or the Media Library (it is probably part of the theme), so it can't be changed safely from here.",
          });
        }
        continue;
      }

      if (request.kind === "replace-link") {
        if (post && replaceHref(post.raw, request.from, request.to) !== null) {
          add({
            request,
            target: post.target,
            op: { type: "replace-href", from: request.from, to: request.to },
            label: `Broken link on ${page}`,
            before: request.from,
            after: request.to,
          });
        } else {
          result.manual.push({
            request,
            reason: "This link is in a menu, widget or the theme rather than the page content. Change it under Appearance → Menus, or ask your developer.",
          });
        }
        continue;
      }

      if (post && wrapTel(post.raw, request.text, request.href) !== null) {
        add({
          request,
          target: post.target,
          op: { type: "wrap-tel", text: request.text, href: request.href },
          label: `Tap-to-call phone number on ${page}`,
          before: request.text,
          after: `${request.text} (linked to ${request.href})`,
        });
      } else {
        result.manual.push({
          request,
          reason: "This phone number is in the header, footer or theme rather than the page content, so it needs a theme edit.",
        });
      }
    }
    return result;
  }

  async applyBatch(target: ChangeTarget, ops: ChangeOp[]): Promise<Snapshot> {
    if (target.kind === "wp-media") {
      const value = [...ops].reverse().find((op) => op.type === "set-alt-text");
      if (!value || value.type !== "set-alt-text") throw new PlatformError("No alt text change to apply.");
      const media = await this.request<WpMedia>("GET", `/wp/v2/media/${target.id}?context=edit&_fields=id,alt_text`);
      const before = media.alt_text ?? "";
      if (before.trim()) throw new PlatformError("This image already has alt text now, so nothing was changed.");
      const updated = await this.request<WpMedia>("POST", `/wp/v2/media/${target.id}?context=edit`, { alt_text: value.value });
      return { before, after: updated.alt_text ?? value.value };
    }

    const post = await this.request<WpPost>("GET", `/wp/v2/${target.type}/${target.id}?context=edit&_fields=id,content`);
    const before = post.content?.raw ?? "";
    let after = before;
    for (const op of ops) {
      const next = applyContentOp(after, op);
      if (next === null) {
        throw new PlatformError("This page changed after the fix was prepared, so nothing was published for it. Prepare the fixes again.");
      }
      after = next;
    }
    const updated = await this.request<WpPost>("POST", `/wp/v2/${target.type}/${target.id}?context=edit`, { content: after });
    return { before, after: updated.content?.raw ?? after };
  }

  async revertBatch(target: ChangeTarget, snapshot: Snapshot): Promise<void> {
    if (target.kind === "wp-media") {
      const media = await this.request<WpMedia>("GET", `/wp/v2/media/${target.id}?context=edit&_fields=id,alt_text`);
      if ((media.alt_text ?? "") !== snapshot.after) {
        throw new PlatformError("The alt text was edited again after publishing, so it was not undone. Change it in the Media Library.");
      }
      await this.request("POST", `/wp/v2/media/${target.id}`, { alt_text: snapshot.before });
      return;
    }
    const post = await this.request<WpPost>("GET", `/wp/v2/${target.type}/${target.id}?context=edit&_fields=id,content`);
    if ((post.content?.raw ?? "") !== snapshot.after) {
      throw new PlatformError("This page was edited again after publishing, so it was not undone automatically. Use the page's Revisions in WordPress.");
    }
    await this.request("POST", `/wp/v2/${target.type}/${target.id}`, { content: snapshot.before });
  }
}
