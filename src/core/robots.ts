/**
 * robots.txt parsing and matching following Google's documented rules:
 * the most specific user-agent group wins, then the longest matching rule,
 * with Allow winning ties. Supports * and $ wildcards.
 */

export interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobotsTxt(content: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
    } else if ((field === "allow" || field === "disallow") && current) {
      // An empty Disallow means "allow everything" and adds no rule.
      if (value) current.rules.push({ allow: field === "allow", path: value });
    }
  }
  return { groups, sitemaps };
}

function ruleMatches(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith("$");
  const pattern = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
}

function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | undefined {
  const agent = userAgent.toLowerCase();
  let best: RobotsGroup | undefined;
  let bestLength = -1;
  for (const group of robots.groups) {
    for (const name of group.agents) {
      if (name !== "*" && agent.includes(name) && name.length > bestLength) {
        best = group;
        bestLength = name.length;
      }
    }
  }
  if (best) return best;
  return robots.groups.find((group) => group.agents.includes("*"));
}

/** True when `userAgent` may not crawl `path` (path includes query string). */
export function isDisallowed(robots: RobotsTxt, userAgent: string, path = "/"): boolean {
  const group = groupFor(robots, userAgent);
  if (!group) return false;
  let verdict: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const length = rule.path.length;
    if (!verdict || length > verdict.length || (length === verdict.length && rule.allow)) {
      verdict = { allow: rule.allow, length };
    }
  }
  return verdict ? !verdict.allow : false;
}

/** AI crawlers worth checking, grouped by what blocking them affects. */
export const AI_CRAWLERS: { agent: string; owner: string; purpose: "search" | "training" | "user" }[] = [
  { agent: "OAI-SearchBot", owner: "OpenAI", purpose: "search" },
  { agent: "ChatGPT-User", owner: "OpenAI", purpose: "user" },
  { agent: "GPTBot", owner: "OpenAI", purpose: "training" },
  { agent: "Claude-SearchBot", owner: "Anthropic", purpose: "search" },
  { agent: "Claude-User", owner: "Anthropic", purpose: "user" },
  { agent: "ClaudeBot", owner: "Anthropic", purpose: "training" },
  { agent: "PerplexityBot", owner: "Perplexity", purpose: "search" },
  { agent: "Perplexity-User", owner: "Perplexity", purpose: "user" },
  { agent: "Google-Extended", owner: "Google (Gemini)", purpose: "training" },
  { agent: "Applebot-Extended", owner: "Apple", purpose: "training" },
  { agent: "CCBot", owner: "Common Crawl", purpose: "training" },
  { agent: "Bingbot", owner: "Microsoft (Bing, Copilot)", purpose: "search" },
  { agent: "Googlebot", owner: "Google Search", purpose: "search" },
];
