# Deployment (Vercel)

The website audits need no configuration at all. Publishing approved fixes to websites needs an encryption key and a storage backend (a private Vercel Blob store or Upstash Redis). Google Search Console / GA4 verification additionally needs a Google OAuth client. All values live in Vercel environment variables, never in the repository.

## 1. Deploy the app

1. Push this repository to GitHub.
2. In Vercel, switch to the target team, then **Add New → Project → Import** this repository. Make sure the Vercel GitHub App has access to the repository (GitHub → Settings → Applications → Vercel → Configure).
3. Framework preset: **Next.js** (detected automatically). No build settings need changing.
4. Deploy. The connector URL is `https://<your-project>.vercel.app/api/mcp`.

> **Deployment Protection:** Vercel protects preview deployments by default, so Claude cannot reach preview URLs. Use the production domain (or a custom domain such as `mcp.incrementors.com`) as the connector URL.

At this point all audit tools work. The Google tools reply that Google is not configured yet.

## 2. Environment variables

Set these in **Project → Settings → Environment Variables** (see `.env.example`):

| Variable | Required for | Notes |
|---|---|---|
| `PUBLIC_BASE_URL` | Google | Stable public URL, for example `https://incrementors-audit-mcp.vercel.app`. Must match the OAuth redirect URI. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google | From step 4. |
| `TOKEN_ENCRYPTION_KEY` | Publishing, Google | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `BLOB_READ_WRITE_TOKEN` | Publishing, Google | Set automatically when a private Blob store is connected (step 3). |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Publishing, Google | Alternative to Blob: set automatically by the Upstash integration (step 3). `UPSTASH_REDIS_REST_URL`/`_TOKEN` also work. Used first when both are present. |
| `PAGESPEED_API_KEY` | Optional | Higher PageSpeed Insights quota for Core Web Vitals. |
| `INCREMENTORS_CONTACT_URL` | Optional | Overrides the contact link in expert-help replies. |
| `MCP_VERBOSE_LOGS` | Optional | `true` logs each MCP request. |

Redeploy after changing variables.

## 3. Storage (Vercel Blob or Upstash Redis)

Either one works:

- **Vercel Blob (simplest):** **Storage → Create → Blob**, choose **Private** access and connect it to the project. It injects `BLOB_READ_WRITE_TOKEN`.
- **Upstash Redis:** **Storage → Marketplace → Upstash (Redis) → Create**, connect it to the project. It injects the `KV_REST_API_*` variables. The free tier is enough for testing.

Without storage, the publishing and Google tools refuse to run on Vercel (serverless instances do not share memory). Website connections, approval pages and Google connections are all stored there; credentials and Google tokens are encrypted with `TOKEN_ENCRYPTION_KEY` before they are written. The Blob store must be private. Locally, an in-memory store is used automatically.

## 4. Google OAuth client

In [Google Cloud Console](https://console.cloud.google.com/):

1. Create (or pick) a project.
2. **APIs & Services → Library**: enable **Google Search Console API**, **Google Analytics Data API** and **Google Analytics Admin API**. Optionally enable **PageSpeed Insights API** and create an API key for `PAGESPEED_API_KEY`.
3. **Google Auth Platform → Branding / Audience**: user type **External**, app name "Incrementors Website Audit", support email, privacy policy URL `https://<your-domain>/privacy`, authorized domain = your deployment domain.
4. **Data Access**: add scopes `openid`, `email`, `https://www.googleapis.com/auth/webmasters.readonly`, `https://www.googleapis.com/auth/analytics.readonly`.
5. **Clients → Create client → Web application**. Authorized redirect URIs:
   - `https://<your-domain>/api/google/callback`
   - `http://localhost:3000/api/google/callback` (local development)
6. Copy the client ID and secret into the Vercel variables.

While the app's publishing status is **Testing**, only listed test users can sign in and Google expires refresh tokens after 7 days (users then reconnect). For a public launch, publish the app and complete Google's verification for the sensitive scopes.

## Local development with Google

```bash
cp .env.example .env.local
# fill GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY; PUBLIC_BASE_URL=http://localhost:3000
npm run dev
```

## Production hardening checklist

Not needed for the development deployment; planned once functionality is final:

- [ ] Rate limiting per IP and per target domain (Upstash Ratelimit) to prevent abuse of the crawler.
- [ ] Short-lived caching of audit fetches per URL to cut repeat load on audited sites.
- [ ] Error monitoring and structured logs (Sentry or Vercel Observability), without logging tokens or connection IDs.
- [ ] Google OAuth app verification and a legally reviewed privacy policy and terms.
- [ ] Custom domain (for example `mcp.incrementors.com`) and listing in Claude's connector directory.
- [ ] Optional MCP-native OAuth so Google access is tied to a signed-in user rather than a connection ID.
- [ ] Usage analytics (which tools run, completion rates) to guide the roadmap.
- [ ] Load test the full audit on large sites; tune page limits and time budgets.
