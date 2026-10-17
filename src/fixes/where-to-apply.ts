import type { FixTarget } from "./generators";

export type Platform = "html" | "wordpress" | "shopify" | "wix" | "squarespace" | "webflow" | "other";

/** Where each kind of manual change is made on common platforms. */
const WHERE: Record<Platform, Partial<Record<FixTarget, string>>> = {
  html: {
    head: "Edit the page's <title> and meta description in its template or CMS SEO fields.",
    "image-alt": "Add the alt attribute to the <img> tag.",
    link: "Update the href in the page content.",
    "body-element": "Edit the text in the page content.",
  },
  wordpress: {
    head: "Use your SEO plugin's title and meta fields on the page (Yoast, Rank Math or All in One SEO).",
    "image-alt": "Media Library → select the image → Alternative Text (also fix it in the block editor where the image is used).",
    link: "Edit the page in the block editor, or Appearance → Menus for navigation links.",
    "body-element": "Edit the block that contains the text.",
  },
  shopify: {
    head: "Open the product, page or collection → 'Search engine listing' → Edit.",
    "image-alt": "Edit the image in the product media and set the alt text.",
    link: "Edit the link in the page content or Online Store → Navigation.",
    "body-element": "Edit the text in the page or product description.",
  },
  wix: {
    head: "Pages menu → page → SEO basics.",
    "image-alt": "Select the image → Settings → 'What's in the image?'.",
    link: "Select the element → Link settings.",
    "body-element": "Edit the text box in the Wix editor.",
  },
  squarespace: {
    head: "Page settings → SEO tab.",
    "image-alt": "Edit the image block → Content → Image alt text.",
    link: "Edit the link in the page.",
    "body-element": "Edit the text block in the page editor.",
  },
  webflow: {
    head: "Page settings → SEO settings.",
    "image-alt": "Select the image → Settings panel → Alt text (or the asset's alt text in Assets).",
    link: "Select the link → Link settings.",
    "body-element": "Edit the text in the Designer or CMS item.",
  },
  other: {},
};

export function whereToApply(platform: Platform, target: FixTarget): string {
  return WHERE[platform][target] ?? WHERE.html[target] ?? "Apply in your site's editor.";
}
