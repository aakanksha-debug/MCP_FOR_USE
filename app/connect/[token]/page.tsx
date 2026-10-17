import type { Metadata } from "next";
import { safeFetch } from "@/core/http";
import { readConnectToken } from "@/platforms/connections";
import { PlatformError } from "@/platforms/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Connect your website | Incrementors Website Audit",
  robots: { index: false, follow: false },
};

/** null when the site could not be checked. */
async function looksLikeWordPress(host: string): Promise<boolean | null> {
  const home = await safeFetch(`https://${host}/`, { timeoutMs: 6_000, maxBytes: 512 * 1024 });
  if (home.status === 0) return null;
  return /wp-content|wp-includes|wp-json/i.test(home.body) || /api\.w\.org/.test(home.headers.link ?? "");
}

export default async function ConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;

  let link: { host: string } | null = null;
  try {
    link = await readConnectToken(token);
  } catch (err) {
    return (
      <main>
        <h1>Website connection unavailable</h1>
        <p>{err instanceof PlatformError ? err.message : "Something went wrong. Please try again later."}</p>
      </main>
    );
  }
  if (!link) {
    return (
      <main>
        <h1>This link has expired</h1>
        <p>Connection links work once and expire after 30 minutes. Ask Claude for a new one.</p>
      </main>
    );
  }

  const wordpress = await looksLikeWordPress(link.host);
  if (wordpress === false) {
    return (
      <main>
        <h1>Connect {link.host}</h1>
        <div className="alert warn">
          <p>
            This site doesn&apos;t look like WordPress. Publishing fixes directly currently works with WordPress only. For other
            platforms, Claude will give you ready-to-copy fixes instead, so you don&apos;t need to connect anything.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Connect {link.host}</h1>
      <p>
        Connecting lets Incrementors Website Audit publish the minor SEO fixes <strong>you approve</strong>. You will review every
        change before anything goes live.
      </p>

      <div className="card">
        <strong>What it will do (only after you approve each change)</strong>
        <ul>
          <li>Add missing image alt text</li>
          <li>Fix broken links inside page content</li>
          <li>Make phone numbers in page content tap-to-call</li>
        </ul>
        <strong>What it will never do</strong>
        <ul>
          <li>Install, update or delete plugins</li>
          <li>Change your theme or add code snippets</li>
          <li>Change settings, redirects or indexing</li>
          <li>Publish anything you have not approved</li>
        </ul>
      </div>

      {error ? (
        <div className="alert warn">
          <p>{error}</p>
        </div>
      ) : null}

      <form method="post" action={`/api/site-connect/${token}`} className="card">
        <input type="hidden" name="platform" value="wordpress" />
        <label htmlFor="siteUrl">WordPress site</label>
        <input id="siteUrl" name="siteUrl" type="url" value={`https://${link.host}`} readOnly />

        <label htmlFor="username">WordPress username</label>
        <input id="username" name="username" type="text" autoComplete="username" required />

        <label htmlFor="appPassword">Application password</label>
        <input id="appPassword" name="appPassword" type="password" autoComplete="off" required />
        <p>
          Create one in WordPress: <strong>Users → Profile → Application Passwords</strong>, enter the name &quot;Incrementors
          MCP&quot;, click <strong>Add New Application Password</strong> and paste it here. Use an Editor or Administrator
          account. This is not your normal login password, and you can revoke it at any time.
        </p>

        <label className="check">
          <input type="checkbox" name="consent" value="yes" required />
          <span>
            I own or manage this website and allow Incrementors Website Audit to publish only the changes I approve.
          </span>
        </label>

        <div className="actions">
          <button className="button" type="submit">
            Connect website
          </button>
        </div>
      </form>

      <p>
        Your password is encrypted and stored for up to 30 days. Disconnect any time by asking Claude to disconnect the website,
        or by revoking the application password in WordPress.
      </p>
    </main>
  );
}
