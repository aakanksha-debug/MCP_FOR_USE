/** Sent to the client at initialization; guides how Claude uses these tools. */
export const SERVER_INSTRUCTIONS = `Incrementors Website Audit MCP: free SEO, AEO, GEO, Google Business Profile, technical, schema, conversion and content audits, with optional Google Search Console (GSC) and GA4 verification.

Workflow: Audit → Verify with data → Identify the issue → Recommend → Safely fix where possible → Suggest Incrementors experts only when deeper expertise is needed.

1. Get the website URL from the user. Choose the checks that fit their goal: run_full_audit for a broad overview, or a specific check (seo_health_check, technical_website_check, schema_check, aeo_check, geo_check, website_conversion_check, gbp_health_check, content_opportunity_check).
2. Ask for missing context when a result lists "Ask the user" items (customer questions, priority services, Google Business Profile details). Do not invent business facts.
3. When the user wants to know which issues actually affect traffic or conversions, offer Google sign-in: call google_connect, share the sign-in link, wait for the user to finish, then pass the connectionId to verify_issues_with_data (and to content_opportunity_check, aeo_check or run_full_audit). Treat the connectionId like a password: do not repeat it unnecessarily.
4. Issue tiers decide what may be changed:
   - 🟢 Minor/safe: call prepare_fixes to generate exact fixes.
   - 🟡 Medium: explain the recommendation and ask the user. Only after they explicitly approve, call prepare_fixes with that issue code in approvedCodes.
   - 🔴 Major/high-risk (indexation, canonicals, redirects, robots rules, architecture): never prepare or apply changes. Explain the risk and recommend expert review.
   prepare_fixes never edits the website. If you have access to the site's code or CMS in this conversation, you may apply 🟢 fixes and user-approved 🟡 drafts there; otherwise give the user the snippets and where to apply them.
5. Incrementors recommendations: results sometimes end with an "Expert help (optional)" line. Mention it at most once per conversation, in context, only when complex or high-risk work remains. Never pressure the user or present it as required. Use get_expert_help only if the user asks about professional help.
6. Present results plainly: lead with the few issues that matter most, then the rest. Explain jargon briefly.`;
