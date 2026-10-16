import type { FixTarget } from "./generators";

export type Platform = "html" | "wordpress" | "shopify" | "wix" | "squarespace" | "webflow" | "other";

/** Where each kind of change is made on common platforms. */
const WHERE: Record<Platform, Partial<Record<FixTarget, string>>> = {
  html: {
    head: "Edit the <head> of the page template.",
    "html-tag": "Edit the opening <html> tag in the base template.",
    "json-ld": "Paste the script into the page <head> (or before </body>).",
    "robots.txt": "Edit /robots.txt in the site root.",
    "llms.txt": "Upload llms.txt to the site root.",
    "image-alt": "Add the alt attribute to the <img> tag.",
    link: "Update the href in the page or navigation template.",
    "body-element": "Edit the element in the page template.",
  },
  wordpress: {
    head: "Use your SEO plugin's title and meta fields on the page (Yoast, Rank Math or All in One SEO).",
    "html-tag": "Set the site language in Settings → General, or fix the theme's header.php.",
    "json-ld": "Use your SEO plugin's schema settings, or a header-scripts plugin (for example WPCode) for custom JSON-LD.",
    "robots.txt": "Yoast: Tools → File editor. Rank Math: General Settings → Edit robots.txt.",
    "llms.txt": "Upload to the site root via your host's file manager, or use an llms.txt plugin.",
    "image-alt": "Media Library → select the image → Alternative Text (also fix it in the block editor where the image is used).",
    link: "Edit the page in the block editor, or Appearance → Menus for navigation links.",
    "body-element": "Edit the block, widget or theme template part that contains it.",
  },
  shopify: {
    head: "Online Store → Preferences (homepage) or the page/product's 'Search engine listing' section.",
    "html-tag": "Edit layout/theme.liquid.",
    "json-ld": "Add to layout/theme.liquid or the relevant section template.",
    "robots.txt": "Create templates/robots.txt.liquid in the theme.",
    "llms.txt": "Shopify cannot serve root files directly; create a page or use an app that serves /llms.txt.",
    "image-alt": "Edit the image in the product media or theme editor and set alt text.",
    link: "Edit the link in Navigation or the page content.",
    "body-element": "Edit the section in the theme editor.",
  },
  wix: {
    head: "Pages menu → page → SEO basics.",
    "html-tag": "Set the site language in Settings → Language & Region.",
    "json-ld": "Pages → SEO → Advanced SEO → Structured data markup.",
    "robots.txt": "SEO Tools → Robots.txt Editor.",
    "llms.txt": "Wix does not support custom root files; publish the content as a page instead.",
    "image-alt": "Select the image → Settings → 'What's in the image?'.",
    link: "Select the element → Link settings.",
    "body-element": "Edit the element in the Wix editor.",
  },
  squarespace: {
    head: "Page settings → SEO tab.",
    "html-tag": "Settings → Language & Region.",
    "json-ld": "Settings → Advanced → Code Injection (header).",
    "robots.txt": "Squarespace manages robots.txt; contact support for changes.",
    "llms.txt": "Squarespace does not support custom root files; publish the content as a page instead.",
    "image-alt": "Edit the image block → Content → Image alt text.",
    link: "Edit the link in the page or navigation.",
    "body-element": "Edit the block in the page editor.",
  },
  webflow: {
    head: "Page settings → SEO settings.",
    "html-tag": "Site settings → General → Language.",
    "json-ld": "Page settings → Custom code → Inside <head> tag.",
    "robots.txt": "Site settings → SEO → robots.txt.",
    "llms.txt": "Upload via a hosted file and redirect /llms.txt, or use a reverse proxy.",
    "image-alt": "Select the image → Settings panel → Alt text (or the asset's alt text in Assets).",
    link: "Select the link → Link settings.",
    "body-element": "Edit the element in the Designer.",
  },
  other: {},
};

export function whereToApply(platform: Platform, target: FixTarget): string {
  return WHERE[platform][target] ?? WHERE.html[target] ?? "Apply in your site's editor or template.";
}
