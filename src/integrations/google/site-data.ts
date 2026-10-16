import type { SearchRow } from "@/core/search-data";
import { getAccessToken } from "./connections";
import { GoogleIntegrationError } from "./errors";
import { recentRange } from "./dates";
import { listSites, matchProperty, queryPageRows } from "./gsc";

/** Finds the Search Console property for a site, or explains why none matched. */
export async function resolveGscProperty(accessToken: string, siteUrl: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const sites = await listSites(accessToken);
  const property = matchProperty(sites, siteUrl);
  if (!property) {
    const available = sites.map((site) => site.siteUrl).slice(0, 10);
    throw new GoogleIntegrationError(
      `No Search Console property for ${siteUrl} is available to this Google account.${
        available.length ? ` Available properties: ${available.join(", ")}.` : " The account has no Search Console properties."
      }`,
      "not_found",
    );
  }
  return property;
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

/** Query+page rows for a site over the last `days` days, limited to the site's host. */
export async function loadSearchRows(
  connectionId: string,
  siteUrl: string,
  options: { property?: string; days?: number } = {},
): Promise<{ property: string; rows: SearchRow[]; period: string }> {
  const accessToken = await getAccessToken(connectionId);
  const property = await resolveGscProperty(accessToken, siteUrl, options.property);
  const range = recentRange(options.days ?? 90);
  const rows = (await queryPageRows(accessToken, property, range)).filter((row) => sameHost(row.page, siteUrl));
  return { property, rows, period: `${range.startDate} to ${range.endDate}` };
}
