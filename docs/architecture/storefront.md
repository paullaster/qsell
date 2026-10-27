# The storefront

Search engines and shared links: see [seo.md](seo.md).

What a shopper sees, how it is built, and the rules it keeps.

## Pages

| Address | What | Notes |
|---|---|---|
| `/` | The shop: products, categories, price, stock, sort, search | Everything the shopper chooses is in the address (`?q=&category=&min=&max=&stock=1&sort=&cursor=`), so a result can be shared and Back undoes it. Parsed by `parseStorefrontQuery` (`src/lib/storefront-search.ts`): anything that makes no sense is dropped, never rejected. |
| `/product/<slug>` | One product | The address is the product's slug. An older link by id, or a slug that has since changed, redirects (308) to the current one. Carries its own title, description, canonical address, Open Graph/Twitter data and schema.org `Product` + `BreadcrumbList` JSON-LD. |
| `/checkout` | Checkout | A page, not a modal: form and order beside each other, then the wait for the payment, then the confirmation. `noindex`. |
| `/policies/<slug>` | Privacy, delivery, returns... | Written by the company in Admin → Company → Policies. Plain text only (`parsePolicyBody`); nothing in it is ever treated as markup. |
| `/help` | Contact, guarantees and FAQs | The company's own help content as readable text with `FAQPage`/`ContactPage` data. See [seo.md](seo.md). |
| `/platform` | The software behind the shop, module by module | See [seo.md](seo.md). |
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

### Paying from a different phone

A customer can pay with any Kenyan mobile line, not only the contact number they gave (a spouse's, a work line, a borrowed phone). This applies to every method that works through a phone (`PHONE_PAYMENT_METHODS` in `src/lib/payment-phone.ts`: M-Pesa, KCB Buni, Jenga).

* The checkout shows a **"number to pay from"** field under the payment methods. Empty means the contact number, which is shown inside the box. A different number says it is kept with the order, and a button returns to the contact number. A failed payment offers the same field to **try again from another number**.
* `resolvePaymentPhone` (pure, shared by the browser and the server) decides the number. A phone method refuses anything that is not a Kenyan mobile number, in words; other methods keep a valid number and ignore a bad one. The server runs it again; the browser's check is a convenience.
* **What is recorded:** `payment_attempts.customer_phone` keeps the number of every attempt (a retry from another number is a new attempt with its own number), and `orders.payment_phone` keeps the latest, apart from `customer_phone` (the contact number, which is never changed by paying from elsewhere). Admin → Orders shows "Paid from" and flags when it is not the contact number; the order search finds an order by either number. The customer's own pages show it with the middle hidden (`0712 ••• 678`). What Safaricom reports as the payer is still checked against the attempt's number when the payment is verified, so a payment made from a line other than the one asked is not counted blindly.
* **Safety:** the number is never taken by a public action that only knows an order id. `startOrderPayment` (`src/server/domains/payments/start-payment.ts`) is server code; `initiateBranchPaymentAction` calls it without a phone and always uses the number the order already holds. Only the checkout actions, after validating the number, pass one. A prompt is **rate limited per address and per number** (`payment_prompt_ip`, `payment_prompt_phone`), so nobody's phone can be flooded with prompts.

## Prices, quantity limits and the pricing engine

The shop does not read prices off the product: `withShopPrices` asks the pricing engine for each product (see "One engine for sale, invoicing and display" in [pricing-module.md](pricing-module.md)), and checkout prices the order with the same engine, so what is shown is what is charged. An item may have a minimum and a maximum quantity: the card says so ("Buy 3 to 10 at a time."), the product page starts at the minimum and its stepper stops at the limits, adding from a card adds the minimum, and a cart saved outside the limits is brought into range with a notice. The server refuses any order outside them regardless of what the browser sends.

## The order's stages are on record from the first press of "pay"

Every checkout is on record from the moment the shopper presses pay, before any order exists (`checkout_attempts`): a refusal (a quantity limit, stock short, a rate limit, input that could not be read) keeps its time, where it stopped and why; a guest is a keyed hash, never an address or phone. Once there is an order, every stage it goes through, failures included (a payment that could not be started, a prompt that was declined, an approval refused), is an event with its server time on the order's timeline, written by the one stage writer. The shopper sees the plain stages with their times in *Track my order* and on the confirmation page; staff see all of it, with who and why, in Admin → Orders. See [order-stage-timeline.md](order-stage-timeline.md).

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
