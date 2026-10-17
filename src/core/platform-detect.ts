/**
 * Identifies the website platform from the homepage HTML and headers, so
 * Claude can explain how fixes get applied (connect, copy-paste, or code).
 */

export type PlatformKind = "cms" | "builder" | "code" | "unknown";

export interface DetectedPlatform {
  id: string;
  name: string;
  kind: PlatformKind;
}

const RULES: { id: string; name: string; kind: PlatformKind; test: (html: string, headers: Record<string, string>) => boolean }[] = [
  {
    id: "wordpress",
    name: "WordPress",
    kind: "cms",
    test: (html, headers) => /wp-content\/|wp-includes\/|<meta[^>]+generator[^>]+WordPress/i.test(html) || /api\.w\.org/.test(headers.link ?? ""),
  },
  { id: "shopify", name: "Shopify", kind: "cms", test: (html, headers) => /cdn\.shopify\.com|Shopify\.theme/i.test(html) || "x-shopid" in headers },
  { id: "wix", name: "Wix", kind: "builder", test: (html, headers) => /static\.wixstatic\.com|<meta[^>]+generator[^>]+Wix\.com/i.test(html) || "x-wix-request-id" in headers },
  { id: "squarespace", name: "Squarespace", kind: "builder", test: (html) => /static1\.squarespace\.com|<!-- This is Squarespace/i.test(html) },
  { id: "webflow", name: "Webflow", kind: "builder", test: (html) => /data-wf-site=|<meta[^>]+generator[^>]+Webflow|website-files\.com/i.test(html) },
  { id: "framer", name: "Framer", kind: "builder", test: (html) => /framerusercontent\.com|<meta[^>]+generator[^>]+Framer/i.test(html) },
  { id: "hubspot", name: "HubSpot CMS", kind: "cms", test: (html) => /<meta[^>]+generator[^>]+HubSpot|hs-scripts\.com/i.test(html) },
  { id: "ghost", name: "Ghost", kind: "cms", test: (html) => /<meta[^>]+generator[^>]+Ghost/i.test(html) },
  { id: "drupal", name: "Drupal", kind: "cms", test: (html) => /<meta[^>]+generator[^>]+Drupal|\/sites\/default\/files\//i.test(html) },
  { id: "joomla", name: "Joomla", kind: "cms", test: (html) => /<meta[^>]+generator[^>]+Joomla/i.test(html) },
  { id: "godaddy", name: "GoDaddy Website Builder", kind: "builder", test: (html) => /img1\.wsimg\.com|<meta[^>]+generator[^>]+Starfield/i.test(html) },
  { id: "lovable", name: "Lovable (React app)", kind: "code", test: (html) => /lovable\.app|gpteng\.co|lovable-tagger/i.test(html) },
  { id: "nextjs", name: "Next.js (custom code)", kind: "code", test: (html) => /\/_next\/static\/|__NEXT_DATA__/.test(html) },
  { id: "nuxt", name: "Nuxt (custom code)", kind: "code", test: (html) => /\/_nuxt\/|__NUXT__/.test(html) },
  { id: "gatsby", name: "Gatsby (custom code)", kind: "code", test: (html) => /___gatsby/.test(html) },
  {
    id: "react",
    name: "React or Vite app (custom code)",
    kind: "code",
    test: (html) => /<div id="(root|app)"><\/div>/.test(html) && /<script[^>]+type="module"/.test(html),
  },
];

export function detectPlatform(html: string, headers: Record<string, string>): DetectedPlatform {
  const sample = html.slice(0, 400_000);
  for (const rule of RULES) {
    if (rule.test(sample, headers)) return { id: rule.id, name: rule.name, kind: rule.kind };
  }
  return { id: "unknown", name: "Unknown (custom site or unrecognized builder)", kind: "unknown" };
}
