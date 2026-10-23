# Incrementors Website Audit MCP

A free MCP server (Claude connector) from [Incrementors](https://www.incrementors.com/) that audits any website for SEO, AEO, GEO, Google Business Profile, technical health, structured data, conversions and content gaps. Users can optionally connect Google Search Console and GA4 (read-only) so findings are verified against real traffic data instead of a crawl alone.

**Core flow:** Audit → Verify with data → Identify issue → Recommend → Safely fix where possible → Recommend Incrementors expertise when needed.

## The journey

The MCP never asks for every integration up front. Each step gives useful results, then offers the next deeper one:

1. **Free website audit** (`run_full_audit`), in this order:
   - **SEO, AEO and GEO scores**, then the overall score and the other checks (Technical, Conversion, Schema, Content, plus GBP for local businesses).
   - **Google Search Console and Analytics** numbers and data findings when the user signed in with Google (otherwise an offer to connect).
   - **Website issues in three levels:** 🟢 Minor (safe, predefined fixes the MCP can make: alt text, simple broken internal links, basic metadata, tap-to-call), 🟡 Intermediate (content, internal linking, SEO/AEO and conversion recommendations the client approves), 🔴 Advanced (canonical/indexation, redirects, architecture, complex technical SEO, tracking/CRM changes: expert review only).
   - **Report card:** things we can fix for you, things we recommend, 1 growth opportunity, major issues requiring expert advice. After the owner approves and publishes fixes, `fix_approval_status` reports "N things we fixed".
2. **Safe fixes**: "I found 5 issues that can be safely fixed. Would you like me to fix them?" Fixes are prepared only after a yes, published only after the site owner approves them, and followed by a before/after summary.
3. **Connect Google Search Console** → `search_performance_analysis`: clicks, impressions, CTR, position and their trends, top queries and pages, visibility opportunities.
4. **Connect Google Analytics** (added to the same Google connection) → `traffic_analysis`: traffic, sources, landing pages, engagement, conversions.
5. **Deep data-driven audit** (`data_driven_audit`): website + Search Console + GA4 combined, ranked by business impact (pages seen but not clicked, traffic without conversions, underperforming service pages, searches without a landing page, real customer questions…).
6. **Critical issues**: 🟢 MCP can safely handle · 🟡 requires approval · 🔴 strategic/expert work, with why each 🔴 item needs careful planning.
7. **Incrementors expert** (`connect_with_expert`): recommended only when the audit found expert-level work, with a ready-to-send brief for the strategist.

Every result ends with one clear "Continue → …" step. Trust comes first: problems are never invented or hidden to force the next step.

## Tools

| Group | Tool | What it does |
|---|---|---|
| Audits | `seo_health_check` | Titles, meta descriptions, headings, alt text, thin content, internal and broken links, duplicate metadata, noindex/canonical |
| | `gbp_health_check` | Local signals on the website, plus Google Business Profile details the user provides |
| | `aeo_check` | Question headings, direct answers, FAQ markup, coverage of real customer questions (adds GSC question searches when connected) |
| | `geo_check` | AI crawler access, llms.txt, Organization/sameAs, About page, brand consistency, authorship, dates, evidence, JS-only rendering |
| | `website_conversion_check` | Headline clarity, CTAs and placement, tap-to-call, forms/email, contact link, trust signals, form length |
| | `technical_website_check` | Status, HTTPS, redirects, www duplication, robots.txt, sitemap, canonicals, viewport, lang, mixed content, speed, compression, HSTS, hreflang, optional Core Web Vitals |
| | `schema_check` | Invalid JSON-LD, missing @context, required/recommended properties per type, missing Organization/WebSite/Breadcrumb/Article/Product/FAQ markup |
| | `content_opportunity_check` | Missing key pages, thin service pages, stale blog, priority topics without pages; with GSC: striking-distance, low CTR, question queries, cannibalization |
| | `run_full_audit` | Stage 1: overall and category scores plus the top findings (`detail: "full"` for every finding) |
| Data analysis | `search_performance_analysis` | Search Console: totals and trends, top queries and pages, opportunities |
| | `traffic_analysis` | GA4: traffic, sources, landing pages, engagement and conversions (property found automatically) |
| | `data_driven_audit` | Website + Search Console + GA4 ranked by business impact, critical issues by tier, expert recommendation when warranted |
| Google (optional) | `google_connect`, `google_connection_status`, `google_disconnect` | Read-only Google sign-in, one service at a time (Search Console first, then GA4 on the same connection) |
| | `gsc_list_properties`, `gsc_search_performance`, `gsc_inspect_url` | Search Console data and URL inspection |
| | `ga4_list_properties`, `ga4_page_performance` | GA4 sessions, engagement and key events per page |
| Decisions | `verify_issues_with_data` | Marks each issue as confirmed, likely, no visible impact or not enough data, sorted by priority |
| | `prepare_fixes` | Exact fixes for minor issues (staged for owner approval when a website is connected), drafts for approved medium issues, expert warnings for everything else |
| | `list_issue_types` | Every issue code with its risk tier |
| | `connect_with_expert` | Final stage: free strategy-session link plus a ready-to-send audit brief, only after the user has their results |
| Publishing | `get_fix_plan` | When the user asks to apply changes: detects the platform and explains how to connect, what can be fixed, what facts are needed first and what needs an expert |
| | `connect_website`, `website_connection_status`, `disconnect_website` | Owner connects their website (WordPress) on a secure page with explicit consent |
| | `fix_approval_status` | Shows what the owner approved, published, rejected or undid |

## Issue handling

Every issue has a fixed tier defined in [`src/policy/catalog.ts`](src/policy/catalog.ts), enforced on the server:

- 🟢 **Minor**: content-level fixes only: page titles, meta descriptions, image alt text, broken links in page content, tap-to-call phone numbers.
- 🟡 **Medium**: content and conversion recommendations. A draft only after the user approves that issue.
- 🔴 **Needs expert advice**: high-risk changes (indexing, canonicals, redirects, robots rules) **and anything that needs installing or deleting plugins, adding code snippets, changing the theme or server settings**. The MCP never prepares or applies these; it shows a clear warning to contact an Incrementors SEO strategist.

### Publishing minor fixes: two permission gates

1. **Claude asks first.** It offers to fix the 🟢 issues and, if the user wants them published, asks permission to connect the website (`connect_website`). The owner opens a one-time page, ticks a consent box and enters a WordPress application password there, never in the chat. The connection is verified and bound to the audited domain.
2. **The owner approves on an approval page.** `prepare_fixes` with the connection only *stages* the changes and returns a private approval link. The page shows every before/after; the owner can untick changes and clicks **Approve & publish**. Nothing is written before that. Each published page can be undone from the same page for 30 days, and edits made since are never overwritten.

WordPress is supported for direct publishing (post/page content and Media Library alt text through the built-in REST API; no plugin installed). SEO titles and descriptions live in SEO plugins, so on WordPress they appear as copy-ready manual steps. Other platforms get the same review list with copy-ready fixes; new platforms plug into [`src/platforms`](src/platforms).

## Incrementors recommendations

Recommendations are generated by [`src/decision/recommend.ts`](src/decision/recommend.ts) and are deliberately restrained:

- never shown when only minor issues remain;
- a clear warning for 🔴 issues (high-risk, or plugin/theme/code/server work), pointing to a free session with an Incrementors SEO strategist;
- otherwise shown only for three or more medium issues in one area, or medium issues confirmed by Search Console/GA4 data.

The server instructions tell Claude to mention it at most once per conversation and never to pressure the user.

## User flow

1. The user adds the connector URL (`https://<deployment>/api/mcp`; the bare site URL also works) in Claude: Settings → Connectors → Add custom connector.
2. Claude opens the sign-in page: **Sign in with Google** (read-only Search Console and Analytics, one consent) or **Continue without Google**.
3. They give Claude their website URL. With Google signed in, `run_full_audit` reads their Search Console and GA4 data for the site at the same time as the crawl and adds data-backed findings; no extra step or connection ID is needed. Without it, Claude can still offer `google_connect` later in the conversation.
4. Claude explains the prioritized issues. For minor issues it asks before preparing fixes and, with permission, connects the website; the owner approves each change on the approval page before anything is published. Medium changes need explicit approval; expert-only work is flagged with a clear warning.

## Local development

Requires Node.js 20.18 or newer.

```bash
npm install
cp .env.example .env.local   # all values are optional for website audits
npm run dev                  # http://localhost:3000, MCP at http://localhost:3000/api/mcp
npm run check                # typecheck + tests
```

To try it in Claude Desktop locally, add the URL through `mcp-remote` (see the [mcp-handler docs](https://www.npmjs.com/package/mcp-handler)). To audit a site running on your own machine, set `AUDIT_ALLOW_PRIVATE_HOSTS=true` (ignored on Vercel production).

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for Vercel, environment variables, storage (Vercel Blob or Upstash Redis) and Google OAuth setup. Architecture and extension guides are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security

- No credentials in the codebase; everything comes from environment variables (`.env.example` lists them).
- Audits fetch only public `http(s)` URLs: private, loopback, link-local and metadata addresses are blocked at DNS-resolution time (covers redirects and DNS rebinding), with size, timeout and redirect limits.
- Website credentials (WordPress application passwords) are entered only on the connect page, verified against the audited domain, AES-256-GCM encrypted, kept 30 days and deletable with `disconnect_website`. Approval and connect forms reject cross-site posts.
- Google access is read-only (`webmasters.readonly`, `analytics.readonly`), uses PKCE and one-time links, and tokens are AES-256-GCM encrypted under a hashed connection ID with a 30-day expiry. Users can revoke at any time.
- The connector sign-in is OAuth 2.1 with PKCE (S256 only), exact redirect URI matching (any port only for localhost), one-time 5-minute codes and sealed tokens (1-hour access, 90-day refresh). The sign-in page cannot be framed and its form rejects cross-site posts.

## Status

Development version for testing. See the production hardening checklist in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#production-hardening-checklist).
