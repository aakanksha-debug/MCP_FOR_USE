import { beforeEach, describe, expect, it } from "vitest";
import { WordPressAdapter } from "@/platforms/wordpress";
import { fakeWordPress, type FakeWordPress } from "./fixtures/wordpress";

const BASE = "https://www.acmeplumbing.test";
let wp: FakeWordPress;
let adapter: WordPressAdapter;

beforeEach(() => {
  wp = fakeWordPress({ base: BASE, username: "owner", password: "abcdEFGHijklMNOPqrstUVWX" });
  wp.pages.set(10, {
    id: 10,
    slug: "home",
    link: `${BASE}/`,
    raw: `<p>Call (512) 555-0147 today.</p><img src="${BASE}/wp-content/uploads/team.jpg"><a href="${BASE}/broken-page/">Old specials</a>`,
  });
  wp.media.set(5, { id: 5, source_url: `${BASE}/wp-content/uploads/team.jpg`, alt_text: "" });
  adapter = new WordPressAdapter({ platform: "wordpress", siteUrl: BASE, username: "owner", appPassword: "abcd EFGH ijkl MNOP qrst UVWX" }, wp.fetcher);
});

describe("WordPressAdapter", () => {
  it("verifies credentials and editing rights", async () => {
    await expect(adapter.verify()).resolves.toMatchObject({ siteUrl: BASE, siteName: "Acme Plumbing", user: "Owner" });
    const wrong = new WordPressAdapter({ platform: "wordpress", siteUrl: BASE, username: "owner", appPassword: "nope" }, wp.fetcher);
    await expect(wrong.verify()).rejects.toThrow(/rejected the username or application password/);
    const reader = fakeWordPress({ base: BASE, username: "owner", password: "pw", editor: false });
    await expect(new WordPressAdapter({ platform: "wordpress", siteUrl: BASE, username: "owner", appPassword: "pw" }, reader.fetcher).verify()).rejects.toThrow(
      /cannot edit/,
    );
  });

  it("plans content changes without writing, and sends SEO titles to manual steps", async () => {
    const plan = await adapter.plan([
      { kind: "image-alt", pageUrl: `${BASE}/`, src: `${BASE}/wp-content/uploads/team.jpg`, alt: "Our team" },
      { kind: "replace-link", pageUrl: `${BASE}/`, from: `${BASE}/broken-page/`, to: `${BASE}/offers/` },
      { kind: "tel-link", pageUrl: `${BASE}/`, text: "(512) 555-0147", href: "tel:5125550147" },
      { kind: "seo-title", pageUrl: `${BASE}/`, value: "Emergency Plumbers in Austin | Acme Plumbing" },
      { kind: "replace-link", pageUrl: `${BASE}/`, from: `${BASE}/menu-only/`, to: `${BASE}/` },
    ]);
    expect(plan.planned.map((entry) => entry.op.type)).toEqual(["set-img-alt", "set-alt-text", "replace-href", "wrap-tel"]);
    expect(plan.manual.map((step) => step.request.kind)).toEqual(["seo-title", "replace-link"]);
    expect(plan.manual[0]?.reason).toContain("SEO plugin");
    expect(wp.writes).toEqual([]);
  });

  it("publishes a page's changes in one write and can undo them", async () => {
    const plan = await adapter.plan([
      { kind: "image-alt", pageUrl: `${BASE}/`, src: `${BASE}/wp-content/uploads/team.jpg`, alt: "Our team" },
      { kind: "tel-link", pageUrl: `${BASE}/`, text: "(512) 555-0147", href: "tel:5125550147" },
    ]);
    const pageOps = plan.planned.filter((entry) => entry.target.kind === "wp-post");
    const original = wp.pages.get(10)!.raw;
    const snapshot = await adapter.applyBatch(pageOps[0]!.target, pageOps.map((entry) => entry.op));
    expect(wp.writes).toEqual(["page:10"]);
    expect(wp.pages.get(10)!.raw).toContain('<img alt="Our team"');
    expect(wp.pages.get(10)!.raw).toContain('<a href="tel:5125550147">(512) 555-0147</a>');

    await adapter.revertBatch(pageOps[0]!.target, snapshot);
    expect(wp.pages.get(10)!.raw).toBe(original);
  });

  it("refuses to publish or undo when the page changed in the meantime", async () => {
    const plan = await adapter.plan([{ kind: "replace-link", pageUrl: `${BASE}/`, from: `${BASE}/broken-page/`, to: `${BASE}/offers/` }]);
    const entry = plan.planned[0]!;
    wp.pages.get(10)!.raw = "<p>Rewritten by the owner.</p>";
    await expect(adapter.applyBatch(entry.target, [entry.op])).rejects.toThrow(/changed after the fix was prepared/);
    expect(wp.writes).toEqual([]);

    wp.pages.get(10)!.raw = `<a href="${BASE}/broken-page/">x</a>`;
    const snapshot = await adapter.applyBatch(entry.target, [entry.op]);
    wp.pages.get(10)!.raw += "<p>edited later</p>";
    await expect(adapter.revertBatch(entry.target, snapshot)).rejects.toThrow(/edited again/);
  });

  it("sets Media Library alt text only when it is still empty", async () => {
    const target = { kind: "wp-media" as const, id: 5, sourceUrl: `${BASE}/wp-content/uploads/team.jpg` };
    const snapshot = await adapter.applyBatch(target, [{ type: "set-alt-text", value: "Our team" }]);
    expect(wp.media.get(5)!.alt_text).toBe("Our team");
    await expect(adapter.applyBatch(target, [{ type: "set-alt-text", value: "Other" }])).rejects.toThrow(/already has alt text/);
    await adapter.revertBatch(target, snapshot);
    expect(wp.media.get(5)!.alt_text).toBe("");
  });
});
