# SEO and shared links

The rule is in `docs/PROJECT_RULES.md` section 10. This page says how it is built and what is left to do outside the code.

## Principle

Every deployment sells something different, so nothing is written by hand per shop. Text comes from the company's own setup (`company_settings` and its `uiConfig`) and from the products. The builders are pure functions in `src/lib/seo/`:

| File | Makes |
|---|---|
| `text.ts` | Titles, descriptions and keywords for the front page, categories and products. The trading name leads; the town and country follow; nothing dangles when the town is not entered. |
| `jsonld.ts` | `Store` (organisation) with address, phone, email, `contactPoint`, `sameAs`, `areaServed`; `WebSite` with a search action; `FAQPage`; `ItemList`; the returns policy page. |
| `share.ts` | The picture for a shared link: the app's own resizer (`/_next/image?...&w=1200&q=75`) so WhatsApp and the others accept it. |
| `social.ts` | `og:type=product`, `product:*` tags, and Open Graph/Twitter fields for ordinary pages. |
| `about.ts`, `help.ts`, `platform.ts` | The text of the front-page "About" block, the public help page and the platform page. |

`src/server/domains/storefront/seo.ts` reads the company, its help content and the shop address once per request.

## What each page sends

* **Every page** (root layout): `metadataBase`, a title template `%s | Trading name`, description, keywords, `lang="en-KE"`, Open Graph (`en_KE`), Twitter card, robots with large-image previews, site-verification codes, `geo.region` and `geo.placename`.
* **Shop frame**: `Store` and `WebSite` JSON-LD on every shop page.
* **Front page**: the company's name, tagline and town in the title; a text block "About <name>" with categories and the first guarantees; filtered, sorted or later pages are `noindex,follow`.
* **Product**: title "Name – KES 350 in Nairobi | Shop", description with price, stock and seller, keywords from name, category, brand and tags; Open Graph/Twitter card with a 1200px picture, `og:type=product`, `product:price:*`, availability, brand, category, SKU; `Product` JSON-LD with offer, `itemCondition`, `mpn`, keywords, the returns page when the company wrote one, stars only when approved reviews exist; `BreadcrumbList`.
* **`/help`**: the company's contacts (profile and support channels), guarantees and FAQs as plain text, with `ContactPage`, `BreadcrumbList` and (when questions exist) `FAQPage`. The footer links to it. Before this page the FAQs lived only in a pop-up that search engines cannot read.
* **`/platform`**: describes the software module by module in everyday words; `SoftwareApplication` JSON-LD. See below.
* **Sitemap**: front page, `/help`, `/platform`, categories, policies, and every product with its picture and last change. **Robots**: the shop is open, private areas are closed, and `/api/media/file/` and `/api/company/logo/` stay open so pictures can be indexed.

## Platform SEO: every module counts

`src/config/seo/platform-modules.ts` describes each admin module in everyday words with the phrases people search for. `src/config/seo/platform-modules.test.ts` fails when a navigation module or sub-module is missing, so a new module cannot ship without its entry. Write for a shop owner in Kenya ("point of sale", "stock control", "M-Pesa", "eTIMS").

`/platform` appears on every shop. Many shops carrying the same page would compete with each other, so set `PLATFORM_CANONICAL_URL` to the address of the platform's own site (where this page is the main one) and every shop names it as the original. Without it each page is its own canonical. A shop's own identity stays on its front page; the platform text is never put on the product pages.

## Settings (per deployment, in `.env.runtime`)

| Variable | Use |
|---|---|
| `GOOGLE_SITE_VERIFICATION` | The code Google Search Console gives to prove the site is yours. |
| `BING_SITE_VERIFICATION` | The same for Bing Webmaster Tools (`msvalidate.01`). |
| `PLATFORM_CANONICAL_URL` | See above. |

The shop's public address (`publicBaseUrl` in Company → Profile, else `APP_URL`) must be the real https address; every canonical link, share card and sitemap entry is built from it.

## What the code cannot do (and what to do next)

Nobody can promise a position. The code makes each page correct, complete and readable. Rankings for "online shop in Kisumu" or "POS software Kenya" also depend on things outside the repository:

1. **Verify each shop in Google Search Console and Bing Webmaster Tools**, submit `/sitemap.xml`, and watch Coverage and Core Web Vitals.
2. **Create a Google Business Profile** for each company with the same name, address and phone as Company → Profile. This is what puts a business in the local map results for its town.
3. **Fill the company's setup completely**: town, county, tagline, location label, contacts, FAQs, guarantees and policies. The more it writes, the more the pages say.
4. **Write real product descriptions** and add pictures; add reviews through the shop.
5. **Links from other sites** (directories, social profiles, the company's own pages) and the platform's own domain for the software terms.
6. Keep the pages fast; do not list towns the company does not serve (search engines penalise it).

## Tests

`src/lib/seo/seo.test.ts` (builders), `src/config/seo/platform-modules.test.ts` (registry coverage), `e2e/seo.spec.ts` (the HTML a crawler receives: head tags, structured data, share picture, sitemap, robots).
