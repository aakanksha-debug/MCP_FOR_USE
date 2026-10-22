# Architecture

The project is a Next.js app on Vercel that exposes one MCP endpoint (`/api/mcp`, Streamable HTTP via [`mcp-handler`](https://www.npmjs.com/package/mcp-handler)), a small OAuth server for signing in when the connector is added, and routes for the Google sign-in. Everything else lives in `src/`, split into layers that only depend downward.

```
app/                         HTTP surface (Next.js route handlers and pages)
  api/mcp/route.ts           MCP endpoint (requires the connector sign-in)
  .well-known/oauth-*        OAuth discovery: authorization server and protected resource metadata
  oauth/register|authorize|token  Connector sign-in: client registration, "Sign in with Google" page, tokens
  connect/[token]            Owner connects their website (consent + credentials)
  approve/[token]            Owner reviews, approves, rejects or undoes staged fixes
  api/google/connect         One-time sign-in link → Google consent screen
  api/google/callback        OAuth callback → stores encrypted tokens
  page.tsx, privacy/         Landing and privacy pages

src/auth/                    Connector sign-in (OAuth 2.1 authorization server, sealed client IDs and tokens)
src/mcp/                     MCP layer: tool registration, schemas, formatting, server instructions
  tools/audit-tools.ts       8 audit tools + run_full_audit
  tools/google-tools.ts      Google connection, Search Console and GA4 tools
  tools/decision-tools.ts    verify_issues_with_data, prepare_fixes, list_issue_types, get_expert_help
  format.ts                  Markdown output (every issue carries its code + URL)
  instructions.ts            Workflow guidance sent to Claude at initialization

src/audits/                  One module per audit; each returns findings, never tiers
src/policy/                  Issue catalog (tier, impact, wording, fixability), classification, scoring
src/decision/                Verification against GSC/GA4 data and the Incrementors recommendation rules
src/analysis/                Search Console and GA4 analyses and the combined data-driven audit (pure functions + loaders)
src/funnel/                  The progressive journey: one "Continue → …" next step per stage, expert conversion block
src/fixes/                   Fix generators (minor, content-only), drafts (approved medium), policy enforcement
src/platforms/               Publishing adapters (WordPress), reversible content ops, website connections
src/approvals/               Approval records, staging, publish and undo (owner-triggered only)
src/integrations/            Google (OAuth, GSC, GA4), PageSpeed Insights, storage (Redis/Vercel Blob/memory, encryption)
src/core/                    Safe fetching, HTML extraction, robots/sitemap parsing, per-call context, types
src/config/                  Environment access and Incrementors brand/service links
```

## How a tool call flows

1. `app/api/mcp/route.ts` hands the request to `mcp-handler`, which validates input against the tool's zod schema.
2. The tool creates a fresh `AuditContext` (`src/core/context.ts`). It memoizes fetches for this call only and enforces a time budget that keeps the function under Vercel's 60-second limit. Nothing is shared between users or calls.
3. Audit modules read pages through the context. `safeFetch` blocks private addresses, caps size and time, and records redirects. `extractPage` parses HTML once into plain data (`PageData`).
4. Audits emit `Finding`s (code, URL, detail). `src/policy/classify.ts` attaches tier, impact, wording and fix policy from the catalog, deduplicates and scores.
5. `src/decision/recommend.ts` decides whether an expert-help line is appropriate. `src/mcp/format.ts` renders Markdown.

## The funnel

Each tool returns value for its stage and ends with exactly one next step from `src/funnel/stages.ts`: audit → safe fixes → Search Console → GA4 → data-driven audit → critical issues → expert. Google consent is incremental (`google_connect` with `services`), so users grant Search Console first and add Analytics later on the same connection. The expert recommendation is generated from the findings and only appears when 🔴 work exists.

## Separation of concerns

- **Audits observe, policy decides.** Audits never assign risk. Changing what counts as high-risk is a one-line edit in `src/policy/catalog.ts`, and `prepare_fixes` picks it up automatically.
- **Integrations feed data, decisions interpret it.** `verify.ts` is pure: the tool layer fetches GSC/GA4 data and passes it in, so the rules are unit-tested without Google.
- **Fixes are prepared by the MCP, published by the owner.** Generators derive changes from what is already on the page. Publishing happens only from the approval page, after the owner clicks Approve.

## Extending

**Add an issue type:** add a definition in `src/policy/catalog.ts`, emit its code from an audit. For a safe issue with an automatic fix, add a `FixKind` in `src/core/types.ts` and a generator in `src/fixes/generators.ts` (the policy test fails if a safe fix has no generator).

**Add an audit:** create `src/audits/<name>.ts` implementing `AuditModule`, register it in `src/audits/index.ts` (and `ALL_AUDITS`), add the `AuditId`, register a tool in `src/mcp/tools/audit-tools.ts`, and add fixture-based tests in `tests/audits.test.ts`.

**Add an integration** (for example Bing Webmaster Tools, Ahrefs, Semrush, Google Business Profile API): put the client under `src/integrations/<provider>/`, map its data to a provider-neutral shape (see `SearchRow` in `src/core/search-data.ts`), and feed it into the decision layer. Register its tools in a new file under `src/mcp/tools/` and add it in `src/mcp/server.ts`.

**Add a publishing platform** (Shopify, Webflow, a GitHub repo): implement `PlatformAdapter` in `src/platforms/<name>.ts` (`verify`, `plan`, `applyBatch`, `revertBatch`), register it in `src/platforms/index.ts`, and add its credential form to `app/connect/[token]`. Keep adapters to content-level edits; the tier check in `src/fixes/plan.ts` already keeps expert-only issues away from them.

## Publishing model

`prepare_fixes` produces content-level change requests (`seo-title`, `meta-description`, `image-alt`, `replace-link`, `tel-link`). With a website connection, `src/approvals/stage.ts` asks the adapter to *plan* them: it reads current values and turns each request into a concrete target and op, or a manual step it cannot do. Nothing is written. The plan becomes an approval record; only `src/approvals/publish.ts`, triggered by the owner's click on the approval page, writes to the site. Ops for one page are applied in a single write and the before/after content is kept, so undo restores it exactly, and refuses if the page was edited since.

## Google connection model

**At connector setup (default).** The MCP endpoint answers unauthenticated requests with a 401 that points to the OAuth metadata, so Claude starts a sign-in when the connector is added:

1. Claude registers itself at `/oauth/register` (dynamic client registration). The client ID is the sealed registration, so nothing is stored.
2. `/oauth/authorize` validates the client, redirect URI and PKCE challenge and shows a page with **Sign in with Google** (Search Console and Analytics, read-only, one consent) or **Continue without Google**.
3. After Google consent, `/api/google/callback` stores the encrypted Google tokens under a new connection ID and redirects back to Claude with a one-time code.
4. `/oauth/token` exchanges the code (PKCE checked) for a 1-hour access token and a 90-day refresh token. Both are AES-256-GCM sealed with a key derived from `TOKEN_ENCRYPTION_KEY` and carry the Google connection ID.
5. Every MCP request carries the access token, so tools read the Google connection from it: `run_full_audit` reads Search Console and GA4 in parallel with the crawl, and the other tools need no `connectionId`.

`MCP_SIGN_IN=off` turns the sign-in off and makes the MCP authless again.

**Later, in a conversation.** Users who continued without Google can still connect per conversation:

1. `google_connect` creates a random `connectionId` (returned to Claude) and a one-time `start` token (in the sign-in link). Only a SHA-256 hash of the connection ID is used as the storage key.
2. `/api/google/connect` consumes the start token and redirects to Google with a random `state` and a PKCE challenge.
3. `/api/google/callback` consumes the state, exchanges the code with the PKCE verifier and stores AES-256-GCM encrypted tokens for 30 days.
4. Tools call `getAccessToken(connectionId)`, which refreshes tokens when needed. `google_disconnect` revokes them at Google and deletes them.

In this path the connection ID works like a bearer token inside the user's Claude conversation.

## Testing

`tests/fixtures/site.ts` is a small fictional business site with planted issues, served through a mock fetcher, so every audit, the fix policy, the decision rules and the Google connection lifecycle run offline with `npm test`.
