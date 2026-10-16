import { pageSpeedApiKey } from "@/config/env";

export type VitalsCategory = "FAST" | "AVERAGE" | "SLOW";

export interface CoreWebVitals {
  source: "field" | "lab";
  overall?: VitalsCategory;
  performanceScore?: number;
  metrics: Record<string, { value: number; category?: VitalsCategory }>;
}

const FIELD_METRICS: Record<string, string> = {
  LARGEST_CONTENTFUL_PAINT_MS: "LCP (ms)",
  INTERACTION_TO_NEXT_PAINT: "INP (ms)",
  CUMULATIVE_LAYOUT_SHIFT_SCORE: "CLS (x100)",
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: "TTFB (ms)",
};

/**
 * Google PageSpeed Insights (mobile). Uses real-user field data when Chrome
 * has enough traffic for the URL, otherwise the Lighthouse lab score.
 */
export async function fetchCoreWebVitals(url: string, timeoutMs: number): Promise<CoreWebVitals | { error: string }> {
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("strategy", "mobile");
  endpoint.searchParams.set("category", "performance");
  const key = pageSpeedApiKey();
  if (key) endpoint.searchParams.set("key", key);

  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { error: `PageSpeed Insights returned HTTP ${response.status}` };
    const data = (await response.json()) as {
      loadingExperience?: {
        overall_category?: VitalsCategory;
        metrics?: Record<string, { percentile: number; category: VitalsCategory }>;
      };
      lighthouseResult?: { categories?: { performance?: { score?: number } } };
    };
    const performanceScore = data.lighthouseResult?.categories?.performance?.score;
    const field = data.loadingExperience?.metrics;
    if (field && Object.keys(field).length) {
      const metrics: CoreWebVitals["metrics"] = {};
      for (const [key, label] of Object.entries(FIELD_METRICS)) {
        const metric = field[key];
        if (metric) metrics[label] = { value: metric.percentile, category: metric.category };
      }
      return {
        source: "field",
        ...(data.loadingExperience?.overall_category ? { overall: data.loadingExperience.overall_category } : {}),
        ...(performanceScore !== undefined ? { performanceScore: Math.round(performanceScore * 100) } : {}),
        metrics,
      };
    }
    if (performanceScore === undefined) return { error: "PageSpeed Insights returned no performance data" };
    const score = Math.round(performanceScore * 100);
    return {
      source: "lab",
      overall: score >= 90 ? "FAST" : score >= 50 ? "AVERAGE" : "SLOW",
      performanceScore: score,
      metrics: {},
    };
  } catch (error) {
    return { error: error instanceof Error && error.name === "TimeoutError" ? "PageSpeed Insights timed out" : String(error) };
  }
}
