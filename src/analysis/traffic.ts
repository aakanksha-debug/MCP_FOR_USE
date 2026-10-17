/** GA4 analysis: what happens after visitors arrive. Pure; the tool layer fetches the data. */

export interface TrafficTotals {
  sessions: number;
  users: number;
  engagementRate: number;
  keyEvents: number;
}

export interface ChannelRow {
  channel: string;
  sessions: number;
  engagementRate: number;
  keyEvents: number;
}

export interface LandingRow {
  path: string;
  sessions: number;
  engagementRate: number;
  keyEvents: number;
}

export interface TrafficInput {
  propertyName: string;
  propertyId: string;
  period: string;
  current: TrafficTotals;
  previous: TrafficTotals;
  channels: ChannelRow[];
  landingPages: LandingRow[];
}

export interface TrafficAnalysis {
  input: TrafficInput;
  change: { sessions: number | null; keyEvents: number | null; engagement: number | null };
  keyEventsTracked: boolean;
  weakEngagement: LandingRow[];
  noConversions: LandingRow[];
  organicShare: number | null;
}

function percentChange(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

export function analyzeTraffic(input: TrafficInput): TrafficAnalysis {
  const keyEventsTracked = input.current.keyEvents > 0 || input.landingPages.some((page) => page.keyEvents > 0);
  const topSessions = input.landingPages[0]?.sessions ?? 0;
  const threshold = Math.max(30, Math.round(topSessions * 0.05));
  const meaningful = input.landingPages.filter((page) => page.sessions >= threshold && page.path && page.path !== "(not set)");
  const organic = input.channels.find((channel) => /organic search/i.test(channel.channel));
  return {
    input,
    change: {
      sessions: percentChange(input.current.sessions, input.previous.sessions),
      keyEvents: percentChange(input.current.keyEvents, input.previous.keyEvents),
      engagement: input.previous.engagementRate ? Math.round((input.current.engagementRate - input.previous.engagementRate) * 1000) / 10 : null,
    },
    keyEventsTracked,
    weakEngagement: meaningful.filter((page) => page.engagementRate < 0.45).slice(0, 5),
    noConversions: keyEventsTracked ? meaningful.filter((page) => page.keyEvents === 0).slice(0, 5) : [],
    organicShare: input.current.sessions && organic ? organic.sessions / input.current.sessions : null,
  };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const num = (value: number) => Math.round(value).toLocaleString("en-US");
const trend = (value: number | null, unit = "%") =>
  value === null ? "" : ` (${value === 0 ? "→" : value > 0 ? "▲" : "▼"} ${value > 0 ? "+" : ""}${value}${unit} vs previous period)`;

export function formatTrafficAnalysis(analysis: TrafficAnalysis): string {
  const { input, change } = analysis;
  const lines: string[] = [
    `## Traffic & conversions: ${input.propertyName} (GA4 ${input.propertyId})`,
    input.period,
    "",
    `- **Sessions:** ${num(input.current.sessions)}${trend(change.sessions)}`,
    `- **Users:** ${num(input.current.users)}`,
    `- **Engagement rate:** ${pct(input.current.engagementRate)}${trend(change.engagement, " pts")}`,
    `- **Conversions (key events):** ${analysis.keyEventsTracked ? `${num(input.current.keyEvents)}${trend(change.keyEvents)}` : "not tracked"}`,
  ];
  if (input.channels.length) {
    lines.push("", "**Traffic sources**", ...input.channels.slice(0, 6).map((c) => `- ${c.channel}: ${num(c.sessions)} sessions, ${pct(c.engagementRate)} engaged${analysis.keyEventsTracked ? `, ${num(c.keyEvents)} conversions` : ""}`));
  }
  if (input.landingPages.length) {
    lines.push("", "**Top landing pages**", ...input.landingPages.slice(0, 5).map((p) => `- ${p.path}: ${num(p.sessions)} sessions, ${pct(p.engagementRate)} engaged${analysis.keyEventsTracked ? `, ${num(p.keyEvents)} conversions` : ""}`));
  }
  const meaning: string[] = [];
  if (!analysis.keyEventsTracked) meaning.push("**Conversions aren't tracked**, so we can't see which pages bring enquiries or sales. Marking form submits, calls or purchases as key events in GA4 fixes that.");
  for (const page of analysis.weakEngagement.slice(0, 2)) meaning.push(`**Visitors leave quickly on ${page.path}:** ${num(page.sessions)} sessions but only ${pct(page.engagementRate)} engaged.`);
  for (const page of analysis.noConversions.slice(0, 2)) meaning.push(`**Traffic without conversions on ${page.path}:** ${num(page.sessions)} sessions and no key events.`);
  if (analysis.organicShare !== null) meaning.push(`Organic search brings **${pct(analysis.organicShare)}** of all sessions.`);
  lines.push("", "### What this means", ...(meaning.length ? meaning.map((item) => `- ${item}`) : ["- Engagement and conversions look healthy on the main landing pages."]));
  return lines.join("\n");
}
