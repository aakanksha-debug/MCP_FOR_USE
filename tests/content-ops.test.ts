import { describe, expect, it } from "vitest";
import { replaceHref, setImgAlt, wrapTel } from "@/platforms/content-ops";

const block = `<!-- wp:image {"id":5} -->
<figure class="wp-block-image"><img src="https://x.test/wp-content/uploads/van-1024x768.jpg" class="wp-image-5"/></figure>
<!-- /wp:image -->
<p>Call (512) 555-0147 or see <a href="/old-specials/">specials</a> and <a href="tel:5125550147">(512) 555-0147</a>.</p>`;

describe("content ops", () => {
  it("adds alt only to matching images without alt, matching resized copies", () => {
    const result = setImgAlt(block, "https://x.test/wp-content/uploads/van.jpg", 'Plumbing "van"');
    expect(result).toContain('<img alt="Plumbing &quot;van&quot;" src="https://x.test/wp-content/uploads/van-1024x768.jpg"');
    expect(result).toContain("<!-- wp:image {\"id\":5} -->");
    expect(setImgAlt(result!, "https://x.test/wp-content/uploads/van.jpg", "again")).toBeNull();
    expect(setImgAlt(block, "https://x.test/other.jpg", "x")).toBeNull();
  });

  it("replaces absolute or relative hrefs and leaves other links alone", () => {
    const result = replaceHref(block, "https://x.test/old-specials/", "https://x.test/offers/");
    expect(result).toContain('href="https://x.test/offers/"');
    expect(result).toContain('href="tel:5125550147"');
    expect(replaceHref(block, "https://x.test/missing/", "https://x.test/")).toBeNull();
  });

  it("wraps only a plain-text phone number, never one already linked or inside a tag", () => {
    const result = wrapTel(block, "(512) 555-0147", "tel:+15125550147");
    expect(result).toContain('<p>Call <a href="tel:+15125550147">(512) 555-0147</a> or see');
    expect(result!.match(/tel:/g)).toHaveLength(2);
    expect(wrapTel('<a href="tel:1">(512) 555-0147</a>', "(512) 555-0147", "tel:2")).toBeNull();
    expect(wrapTel('<img title="(512) 555-0147">', "(512) 555-0147", "tel:2")).toBeNull();
  });
});
