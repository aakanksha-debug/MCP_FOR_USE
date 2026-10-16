import type { Fetcher, FetchResult } from "@/core/http";

/**
 * A small fictional business site with known, planted issues. Served through
 * a mock fetcher so audits run without network access.
 */

export const ORIGIN = "https://www.acmeplumbing.test";

interface Route {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  location?: string;
}

const nav = `
<header>
  <a href="/"><img src="/images/logo.png" alt="Acme Plumbing logo"></a>
  <nav>
    <a href="/about/">About</a>
    <a href="/services/drain-cleaning/">Drain Cleaning</a>
    <a href="/blog/old-post/">Blog</a>
    <a href="/contact/">Contact</a>
  </nav>
</header>`;

const footer = `
<footer>
  <a href="https://www.facebook.com/acmeplumbing">Facebook</a>
  <a href="https://www.instagram.com/acmeplumbing">Instagram</a>
  <p>© Acme Plumbing</p>
</footer>`;

const home = `<!doctype html>
<html>
<head>
  <title>Acme Plumbing | Licensed Emergency Plumbers, Drain Cleaning and Water Heaters in Austin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:site_name" content="Acme Plumbing">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme Plumbing","url":"${ORIGIN}/"}</script>
</head>
<body>
${nav}
<main>
  <h1>Welcome</h1>
  <p>Acme Plumbing provides fast, licensed emergency plumbing, drain cleaning and water heater repair for homes and businesses across Austin, Texas. We have served over 2,000 customers in 15 years.</p>
  <img src="/images/team-photo_1200x800.jpg">
  <img src="http://cdn.acmeplumbing.test/images/van.jpg">
  <p>Call us today at (512) 555-0147 for same-day service from a trusted, insured team. Our plumbers arrive in marked vans with fully stocked parts so most repairs are finished in a single visit, and every job comes with a written guarantee.</p>
  <p>Read what our customers say in our reviews, and see why homeowners across Austin trust us with leaks, clogs, burst pipes and water heater replacements.</p>
  <a href="/broken-page/">Our old specials page</a>
  <section>
    <h2>Frequently asked questions</h2>
    <h3>Do you offer emergency plumbing?</h3>
    <p>Yes. Our emergency plumbers are available 24 hours a day, 7 days a week across Austin and nearby suburbs.</p>
    <h3>How fast can a plumber arrive?</h3>
    <p>Most emergency calls are reached within 60 minutes of booking, depending on traffic and the time of day.</p>
    <h3>Are your plumbers licensed?</h3>
    <p>Every plumber on our team is licensed by the Texas State Board of Plumbing Examiners and fully insured.</p>
  </section>
  <a href="/contact/" class="button">Get a free quote</a>
</main>
${footer}
</body>
</html>`;

const about = `<!doctype html>
<html lang="en">
<head>
  <title>About Acme Plumbing | Family-owned Austin Plumbers</title>
  <meta name="description" content="Acme Plumbing is a family-owned plumbing company serving Austin since 2010 with licensed, insured plumbers and upfront pricing.">
  <link rel="canonical" href="${ORIGIN}/about/">
</head>
<body>
${nav}
<main>
  <h1>About Acme Plumbing</h1>
  <p>${"We are a family-owned plumbing company founded in 2010 in Austin, Texas. ".repeat(20)}</p>
  <p>Our team includes 12 licensed plumbers and we have completed over 9,000 jobs.</p>
</main>
${footer}
</body>
</html>`;

const contact = `<!doctype html>
<html lang="en">
<head>
  <title>Contact Acme Plumbing | Book a Plumber in Austin</title>
  <meta name="description" content="Contact Acme Plumbing to book a licensed plumber in Austin. Call (512) 555-0147 or send us a message and we will reply within one hour.">
</head>
<body>
${nav}
<main>
  <h1>Contact Acme Plumbing</h1>
  <address>1200 Congress Avenue, Suite 400, Austin, TX 78701</address>
  <form action="/send">
    <input name="first"><input name="last"><input type="email" name="email"><input type="tel" name="phone">
    <input name="street"><input name="city"><input name="zip"><select name="service"></select><textarea name="message"></textarea>
    <button type="submit">Send</button>
  </form>
</main>
${footer}
</body>
</html>`;

const drainCleaning = `<!doctype html>
<html lang="en">
<head>
  <title>Drain Cleaning in Austin | Acme Plumbing</title>
  <meta name="description" content="Professional drain cleaning in Austin for kitchens, bathrooms and main sewer lines. Same-day appointments with licensed plumbers.">
  <link rel="canonical" href="${ORIGIN}/">
</head>
<body>
${nav}
<main>
  <h1>Drain Cleaning</h1>
  <p>We clear clogged drains quickly using professional equipment. Call us to book a visit.</p>
</main>
${footer}
</body>
</html>`;

const blogPost = `<!doctype html>
<html lang="en">
<head>
  <title>How to Prevent Frozen Pipes in Austin Winters | Acme Plumbing</title>
  <meta name="description" content="Simple steps Austin homeowners can take to stop pipes from freezing during cold snaps, and what to do if a pipe bursts.">
</head>
<body>
${nav}
<main>
  <article>
    <h1>How to Prevent Frozen Pipes</h1>
    <p>${"Insulate exposed pipes in your attic, garage and crawl space before the first freeze. ".repeat(12)}</p>
  </article>
</main>
${footer}
</body>
</html>`;

const robots = `User-agent: *
Allow: /

User-agent: GPTBot
Disallow: /

User-agent: PerplexityBot
Disallow: /
`;

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/</loc></url>
  <url><loc>${ORIGIN}/about/</loc></url>
  <url><loc>${ORIGIN}/contact/</loc></url>
  <url><loc>${ORIGIN}/services/drain-cleaning/</loc></url>
  <url><loc>${ORIGIN}/blog/old-post/</loc><lastmod>2024-01-15</lastmod></url>
</urlset>`;

const html = { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" };

export const ROUTES: Record<string, Route> = {
  [`${ORIGIN}/`]: { body: home, headers: html },
  [`${ORIGIN}/about/`]: { body: about, headers: html },
  [`${ORIGIN}/contact/`]: { body: contact, headers: html },
  [`${ORIGIN}/services/drain-cleaning/`]: { body: drainCleaning, headers: html },
  [`${ORIGIN}/blog/old-post/`]: { body: blogPost, headers: html },
  [`${ORIGIN}/broken-page/`]: { status: 404, body: "<html><body>Not found</body></html>", headers: html },
  [`${ORIGIN}/robots.txt`]: { body: robots, headers: { "content-type": "text/plain" } },
  [`${ORIGIN}/sitemap.xml`]: { body: sitemap, headers: { "content-type": "application/xml" } },
  "http://www.acmeplumbing.test/": { status: 301, location: `${ORIGIN}/` },
  "https://acmeplumbing.test/": { status: 301, location: `${ORIGIN}/` },
};

/** Mock fetcher that serves ROUTES (404 for anything else) and follows redirects like safeFetch. */
export function siteFetcher(routes: Record<string, Route> = ROUTES): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: string, options = {}) => {
    calls.push(`${options.method ?? "GET"} ${input}`);
    const redirects: { url: string; status: number }[] = [];
    let url = input;
    for (let hop = 0; hop < 6; hop += 1) {
      const route: Route = routes[url] ?? { status: 404, body: "", headers: html };
      const status = route.status ?? 200;
      if (route.location && options.followRedirects !== false) {
        redirects.push({ url, status });
        url = new URL(route.location, url).toString();
        continue;
      }
      const body = options.method === "HEAD" ? "" : (route.body ?? "");
      const result: FetchResult = {
        requestedUrl: input,
        url,
        status,
        ok: status >= 200 && status < 300,
        headers: { ...(route.headers ?? {}), ...(route.location ? { location: route.location } : {}) },
        redirects,
        body,
        bytes: body.length,
        truncated: false,
        timingMs: 120,
      };
      return result;
    }
    throw new Error("redirect loop in fixture");
  }) as Fetcher & { calls: string[] };
  fetcher.calls = calls;
  return fetcher;
}
