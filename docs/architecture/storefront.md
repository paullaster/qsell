# The storefront

What a shopper sees, how it is built, and the rules it keeps.

## Pages

| Address | What | Notes |
|---|---|---|
| `/` | The shop: products, categories, price, stock, sort, search | Everything the shopper chooses is in the address (`?q=&category=&min=&max=&stock=1&sort=&cursor=`), so a result can be shared and Back undoes it. Parsed by `parseStorefrontQuery` (`src/lib/storefront-search.ts`): anything that makes no sense is dropped, never rejected. |
| `/product/<slug>` | One product | The address is the product's slug. An older link by id, or a slug that has since changed, redirects (308) to the current one. Carries its own title, description, canonical address, Open Graph/Twitter data and schema.org `Product` + `BreadcrumbList` JSON-LD. |
| `/checkout` | Checkout | A page, not a modal: form and order beside each other, then the wait for the payment, then the confirmation. `noindex`. |
| `/policies/<slug>` | Privacy, delivery, returns... | Written by the company in Admin → Company → Policies. Plain text only (`parsePolicyBody`); nothing in it is ever treated as markup. |
| `/sitemap.xml`, `/robots.txt`, `/manifest.webmanifest` | For search engines and phones | Built from the live catalog. Addresses come from the company's public base URL or `APP_URL`, never from the request's Host header. |

All of these live in `app/(store)/`, whose layout draws the header, footer, cart panel and the panels that open from them (`StoreShell`). Its data (company, currency, payment names, categories, session) is read in parallel on the server and handed over as promises.

## The catalog is read a page at a time

`StorefrontCatalog` (`src/server/domains/catalog/storefront-service.ts`) is the only way the shop reads products. It sees live products only (active, sellable, not deleted) and never returns cost.

* **Keyset paging** on `(sort key, id)` for each of the four orders (name, price up, price down, newest). A page costs the same however far down it is, and nothing is repeated or skipped when products change between pages. A damaged cursor starts from the top.
* **Search** is substring (`ilike '%word%'`), every word must be found in the name, SKU, brand or category name. Typed `%` and `_` are plain letters. Migration `0101` adds `pg_trgm` GIN indexes for these and partial btree indexes for the three sort orders; `storefront-service.integration.test.ts` checks the planner uses them.
* Search does **not** look inside descriptions or tags (that would need a full-text index). Add a `tsvector` column and index if that is wanted.
* A category includes its sub-categories. An unknown or inactive category is an empty page, never "everything".
* "Show more" appends the next page in the browser, and is also a real link (`rel="next"`) to the same page by address.

## The cart

* The browser keeps only product ids, quantities and the price last seen (`qsell_cart_v2`). The first shop's cart (`omnicommerce_cart`, which kept a whole copy of each product) is read once and dropped.
* Every time the cart loads, and when checkout opens, each line is checked against the shop (`reconcileCart`): current price and stock, withdrawn products removed, quantities cut to what is left, and the shopper is told what changed.
* Another tab changing the cart updates this one.

## Checkout and payment

* `placeOrderAction` places the order and starts the payment in one step and answers **as data** (server-action errors are masked in production). Only refusals the shop wrote for the shopper (`CheckoutRefused`) are shown; anything else is logged and answered in general words.
* Prices, stock, customer and payment method are decided on the server; the browser's input is validated by `parseCheckoutInput` and then again by the order service.
* The order holds the stock as soon as it is placed, so the cart is cleared then. A payment that fails leaves a saved order and a "try again" button, never a second order.
* "Paid" is shown only after the provider has told the server so (`PaymentWait` asks the shop; `confirmedOrderAction` reads the order again). The page does not mark an order paid on its own.

## Product pictures

Pictures are always shown whole: `object-contain` on a plain background, never cropped. Cards use a square box; the product page uses a box capped at 70% of the screen height (`ProductGallery`), so the price and buttons stay in view. A tap opens the full-size viewer (`ImageViewer`: zoom, arrow keys, swipe on a phone, Escape closes). The buy panel is sticky beside the gallery on wide screens, and on a phone a price-and-Add bar appears at the foot once the main buttons scroll out of sight (`MobileBuyBar`).

## Reviews

* Table `product_reviews`, one per person per product. Only a signed-in **customer** whose order for that product is `delivered` or `completed` may write one (found by account id or the email on the order); the reviewer is taken from the session, never from the browser.
* A review is `pending` until someone with `reviews:moderate` publishes it (Admin → Sales → Product Reviews). Turning one down needs a reason, which the reviewer is shown. Rewriting a review sends it back to `pending`.
* `products.rating` and `products.review_count` are recalculated from the approved reviews **in the same transaction** that approves, rejects, rewrites or deletes one, so they can never drift. Stars (and the schema.org `aggregateRating`) appear only when there is at least one approved review.
* Text is plain (never markup), 10–2000 characters, no web links; the reviewer is shown as a first name and the last initial. Writing is rate limited (`review_submit`).
* New installs give `reviews:moderate` to the admin and manager roles. **An existing role does not receive it automatically** (the role seed only fills empty roles): grant it in Admin → Roles. Super admin always has it.

## Saved products

Signed-in shoppers: table `wishlist_items` (capped at 200, live products only). Guests: the browser (`qsell_wishlist_v1`). A guest list joins the account's list once at sign-in.

## Newsletter

Double opt-in (table `newsletter_subscribers`): asking only creates a `pending` row and sends a confirmation link; the link opens a page with a button (mail scanners open links, so the link alone changes nothing). Whoever asks gets the same answer, so the form cannot reveal who is on the list. Asking is rate limited per address and per client address. Admin → Customers → Newsletter lists people by status and exports the confirmed addresses as CSV (formula characters neutralised). Nothing sends the news itself: the company mails the exported list from its own tool, and each message must carry an unsubscribe link of the form `/newsletter/unsubscribe?token=…` (`NewsletterService.tokenFor`).

## Banners and policies

Both live in the company's UI config (Admin → Company → Banners / Policies). A banner has days it is shown (compared with the business date, passed in), and its button may only go to a page of the shop or an http(s) address.

## Search

Name, SKU, brand and category are matched as substrings (trigram indexes). Descriptions and tags are matched by whole word or word start through a stored generated `search_vector` column (migration `0102`, GIN index), kept out of `schema.ts` so product reads do not carry it. Every typed word must be found somewhere.

## Not built

* **Sending the newsletter.** Only the list and its opt-in/opt-out exist.
* **Review photos, "helpful" votes, replies from the company.**
* **A wishlist share link.**

## Status codes

The frame's few reads (company, currency, payment names, categories, session) are awaited in `app/(store)/layout.tsx` on purpose: the response status can only be set before the first byte is sent, and a page may need to answer 404 or redirect. Checked on a production build: a missing product, policy or newsletter link answers **404**, an old id link answers **308** to the product's slug, the shop answers 200. Do not move those reads behind a Suspense boundary or a `loading.tsx` above the pages, or search engines will see a 200 for every missing page. The pages' own slow parts (products, reviews, banners) still stream.
