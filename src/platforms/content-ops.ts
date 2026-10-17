import type { ChangeOp } from "./types";

/**
 * Exact, minimal edits to stored page HTML (for example WordPress post
 * content). Each op touches only the matching element and leaves all other
 * markup, including block-editor comments, byte-for-byte unchanged. An op
 * returns null when it cannot be applied, so callers never write a guess.
 */

const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Path (and query) of a URL, so absolute and relative forms compare equal. */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url, "https://placeholder.invalid");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** Strips WordPress size suffixes (-300x200) so resized copies match the original. */
export function imageKey(src: string): string {
  return pathOf(src).replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "");
}

function srcOf(tag: string): string | undefined {
  return tag.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i)?.slice(2).find((value) => value !== undefined);
}

function hasAlt(tag: string): boolean {
  return /\salt\s*=/i.test(tag);
}

/** Adds alt="…" to <img> tags with this source that have no alt attribute. */
export function setImgAlt(html: string, src: string, alt: string): string | null {
  const key = imageKey(src);
  let changed = false;
  const result = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const tagSrc = srcOf(tag);
    if (!tagSrc || imageKey(tagSrc) !== key || hasAlt(tag)) return tag;
    changed = true;
    return tag.replace(/^<img\b/i, `<img alt="${escapeAttr(alt)}"`);
  });
  return changed ? result : null;
}

/** Replaces href values pointing at `from` (absolute or relative form) with `to`. */
export function replaceHref(html: string, from: string, to: string): string | null {
  const forms = [...new Set([from, pathOf(from), pathOf(from).replace(/\/$/, ""), `${pathOf(from).replace(/\/$/, "")}/`])].filter(Boolean);
  const pattern = new RegExp(`(href\\s*=\\s*["'])(${forms.map(escapeRegex).join("|")})(["'])`, "gi");
  let changed = false;
  const result = html.replace(pattern, (_match, open: string, _url: string, close: string) => {
    changed = true;
    return `${open}${escapeAttr(to)}${close}`;
  });
  return changed ? result : null;
}

/** True when `index` falls inside an HTML tag or an <a> element. */
function insideTagOrLink(html: string, index: number): boolean {
  const before = html.slice(0, index);
  if (before.lastIndexOf("<") > before.lastIndexOf(">")) return true;
  const lastOpen = Math.max(before.toLowerCase().lastIndexOf("<a "), before.toLowerCase().lastIndexOf("<a>"));
  return lastOpen > before.toLowerCase().lastIndexOf("</a>");
}

/** Wraps the first plain-text occurrence of a phone number in a tel: link. */
export function wrapTel(html: string, text: string, href: string): string | null {
  let from = 0;
  while (true) {
    const index = html.indexOf(text, from);
    if (index === -1) return null;
    if (!insideTagOrLink(html, index)) {
      return `${html.slice(0, index)}<a href="${escapeAttr(href)}">${text}</a>${html.slice(index + text.length)}`;
    }
    from = index + text.length;
  }
}

/** Applies a content op to HTML; null when it does not apply. */
export function applyContentOp(html: string, op: ChangeOp): string | null {
  switch (op.type) {
    case "set-img-alt":
      return setImgAlt(html, op.src, op.alt);
    case "replace-href":
      return replaceHref(html, op.from, op.to);
    case "wrap-tel":
      return wrapTel(html, op.text, op.href);
    case "set-alt-text":
      return null;
  }
}
