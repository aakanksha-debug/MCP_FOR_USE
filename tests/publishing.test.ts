import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuditContext } from "@/core/context";
import { prepareFixes } from "@/fixes/plan";
import { ORIGIN, siteFetcher } from "./fixtures/site";
import { fakeWordPress } from "./fixtures/wordpress";

const HOME = `${ORIGIN}/`;
const PASSWORD = "abcdEFGHijklMNOPqrstUVWX";

beforeAll(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("PUBLIC_BASE_URL", "https://audit.example.test");
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("VERCEL_ENV", "");
});
afterAll(() => vi.unstubAllEnvs());

function wordpressSite() {
  const wp = fakeWordPress({ base: ORIGIN, username: "owner", password: PASSWORD });
  wp.pages.set(10, {
    id: 10,
    slug: "home",
    link: HOME,
    raw: '<p>Call us today at (512) 555-0147 for same-day service.</p><img src="/images/team-photo_1200x800.jpg">',
  });
  return wp;
}

async function connect(wp: ReturnType<typeof wordpressSite>) {
  const sites = await import("@/platforms/connections");
  const { connectionId, connectUrl } = await sites.createSiteConnection("www.acmeplumbing.test");
  const token = connectUrl.split("/connect/")[1]!;
  await sites.completeSiteConnection(token, { platform: "wordpress", siteUrl: HOME, username: "owner", appPassword: PASSWORD }, wp.fetcher);
  return { connectionId, sites };
}

describe("connecting a website", () => {
  it("binds the connection to the audited domain and verifies credentials", async () => {
    const wp = wordpressSite();
    const sites = await import("@/platforms/connections");
    const { connectionId, connectUrl } = await sites.createSiteConnection("www.acmeplumbing.test");
    expect(connectUrl).toMatch(/^https:\/\/audit\.example\.test\/connect\//);
    const token = connectUrl.split("/connect/")[1]!;
    expect(await sites.readConnectToken(token)).toEqual({ host: "www.acmeplumbing.test" });

    await expect(
      sites.completeSiteConnection(token, { platform: "wordpress", siteUrl: "https://other.test/", username: "owner", appPassword: PASSWORD }, wp.fetcher),
    ).rejects.toThrow(/This link is for www.acmeplumbing.test/);
    await expect(
      sites.completeSiteConnection(token, { platform: "wordpress", siteUrl: HOME, username: "owner", appPassword: "wrong" }, wp.fetcher),
    ).rejects.toThrow(/rejected/);
    expect((await sites.siteConnectionStatus(connectionId)).status).toBe("pending");

    await sites.completeSiteConnection(token, { platform: "wordpress", siteUrl: HOME, username: "owner", appPassword: PASSWORD }, wp.fetcher);
    expect(await sites.siteConnectionStatus(connectionId)).toMatchObject({ status: "connected", platform: "WordPress", user: "Owner" });
    expect(await sites.readConnectToken(token)).toBeNull();

    expect(await sites.disconnectSite(connectionId)).toBe(true);
    expect((await sites.siteConnectionStatus(connectionId)).status).toBe("not_found");
  });
});

describe("approve-before-publish flow", () => {
  it("stages fixes without writing, publishes only what the owner selects, and undoes", async () => {
    const wp = wordpressSite();
    const { connectionId, sites } = await connect(wp);
    const { stageFixes } = await import("@/approvals/stage");
    const { publishChanges, undoBatch, rejectChanges } = await import("@/approvals/publish");
    const { getApproval } = await import("@/approvals/records");

    const results = await prepareFixes(createAuditContext({ fetcher: siteFetcher() }), [
      { code: "seo.meta_description.missing", url: HOME },
      { code: "conversion.phone.not_clickable", url: HOME },
      { code: "seo.images.missing_alt", url: HOME },
      { code: "aeo.faq_schema.missing", url: HOME },
    ]);
    const staged = await stageFixes(results, await sites.loadSite(connectionId, wp.fetcher));

    expect(wp.writes).toEqual([]);
    const approval = staged.approval!;
    expect(approval.changes.map((change) => change.op.type).sort()).toEqual(["set-img-alt", "wrap-tel"]);
    expect(staged.manual.some((item) => item.reason.includes("SEO plugin"))).toBe(true);
    expect(staged.expert.map((item) => item.issueTitle)).toEqual(["Visible FAQ has no FAQPage structured data"]);

    const tel = approval.changes.find((change) => change.op.type === "wrap-tel")!;
    const original = wp.pages.get(10)!.raw;
    expect(await publishChanges(approval.id, [tel.id], wp.fetcher)).toEqual({ published: 1, failed: 0 });
    expect(wp.pages.get(10)!.raw).toContain('<a href="tel:5125550147">(512) 555-0147</a>');
    expect(wp.pages.get(10)!.raw).not.toContain("alt=");

    const afterPublish = (await getApproval(approval.id))!;
    expect(afterPublish.changes.find((change) => change.id === tel.id)?.status).toBe("published");
    expect(afterPublish.changes.find((change) => change.id !== tel.id)?.status).toBe("pending");

    await undoBatch(approval.id, afterPublish.batches[0]!.id, wp.fetcher);
    expect(wp.pages.get(10)!.raw).toBe(original);
    expect((await getApproval(approval.id))!.changes.find((change) => change.id === tel.id)?.status).toBe("reverted");

    expect(await rejectChanges(approval.id)).toBe(1);
    expect(await publishChanges(approval.id, approval.changes.map((change) => change.id), wp.fetcher)).toEqual({ published: 0, failed: 0 });
  });

  it("will not publish after the website is disconnected or the link expires", async () => {
    const wp = wordpressSite();
    const { connectionId, sites } = await connect(wp);
    const { stageFixes } = await import("@/approvals/stage");
    const { publishChanges } = await import("@/approvals/publish");
    const { getApproval, saveApproval } = await import("@/approvals/records");

    const results = await prepareFixes(createAuditContext({ fetcher: siteFetcher() }), [{ code: "conversion.phone.not_clickable", url: HOME }]);
    const { approval } = await stageFixes(results, await sites.loadSite(connectionId, wp.fetcher));
    const ids = approval!.changes.map((change) => change.id);

    const record = (await getApproval(approval!.id))!;
    record.expiresAt = Date.now() - 1;
    await saveApproval(record);
    await expect(publishChanges(approval!.id, ids, wp.fetcher)).rejects.toThrow(/expired/);

    record.expiresAt = Date.now() + 60_000;
    await saveApproval(record);
    await sites.disconnectSite(connectionId);
    await expect(publishChanges(approval!.id, ids, wp.fetcher)).rejects.toThrow(/no longer connected/);
    expect(wp.writes).toEqual([]);
  });
});
