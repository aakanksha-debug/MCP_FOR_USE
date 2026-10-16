import { publicBaseUrl } from "@/config/env";

export const dynamic = "force-dynamic";

const CHECKS = [
  ["SEO Health", "Titles, descriptions, headings, alt text, broken links, thin content."],
  ["GBP Health", "Local signals on your site and your Google Business Profile details."],
  ["AEO Check", "Does the page answer real customer questions directly?"],
  ["GEO Check", "Can AI search systems read, understand and cite your brand?"],
  ["Conversion Check", "Clear offer, calls to action, easy ways to get in touch."],
  ["Technical Check", "HTTPS, redirects, robots.txt, sitemap, canonicals, speed."],
  ["Schema Check", "Missing or broken structured data."],
  ["Content Opportunities", "High-value pages and topics you are missing."],
];

export default function Home() {
  const mcpUrl = `${publicBaseUrl()}/api/mcp`;
  return (
    <main>
      <h1>Incrementors Website Audit MCP</h1>
      <p>
        A free connector for Claude that audits your website for SEO, AEO, GEO, local search, technical health, structured
        data, conversions and content gaps. Connect Google Search Console and GA4 (optional, read-only) to see which issues
        actually affect your traffic.
      </p>

      <div className="card">
        <strong>Connector URL</strong>
        <p>
          <code>{mcpUrl}</code>
        </p>
        <p>
          In Claude, open Settings → Connectors → Add custom connector, paste this URL, then ask Claude to audit your
          website.
        </p>
      </div>

      <h2>What it checks</h2>
      <div className="grid">
        {CHECKS.map(([name, description]) => (
          <div className="card" key={name}>
            <h3>{name}</h3>
            <p>{description}</p>
          </div>
        ))}
      </div>

      <h2>How changes are handled</h2>
      <ul>
        <li>🟢 Minor, low-risk issues: exact fixes are prepared for you to apply.</li>
        <li>🟡 Medium issues: recommendations first, drafts only after you approve.</li>
        <li>🔴 High-risk issues (indexation, canonicals, redirects): never changed automatically; expert review recommended.</li>
      </ul>

      <p>
        Built by <a href="https://www.incrementors.com/">Incrementors</a>. <a href="/privacy">Privacy</a>
      </p>
    </main>
  );
}
