# The web shop, end to end

How a person gets from the front page to a delivered, invoiced, paid order, and what the system does at each step. Written from the code (2026-11-08). Each statement is marked where it matters: **[tested]** (a test covers it), **[code]** (read in the code, not run), **[ran]** (I ran it against a real database). Parts that are covered in depth elsewhere link to that page and are summarised here.

Related pages: [storefront.md](storefront.md) (pages, catalog, cart, reviews, newsletter), [seo.md](seo.md), [pricing-module.md](pricing-module.md), [kits-and-hampers.md](kits-and-hampers.md), [delivery-module.md](delivery-module.md), [stock-locations.md](stock-locations.md), [order-stage-timeline.md](order-stage-timeline.md), [core-finance-module.md](core-finance-module.md).

## 0. The shape in one picture

```
 Arrive ──► Browse / search ──► Product ──► Cart ──► Checkout form ──► Place order ──► Pay ──► Confirmation
 (shell,     (URL holds the     (engine     (browser   (details, address,   (one server     (STK /      (invoice on
  banners)    whole query)       price,      keeps ids  delivery or pickup,  call: checks,   hosted /    request, track
                                 stock)      only)      payment method)      stock held)     account /   link)
                                                                                             on delivery)
                                                              │                                  │
                                           every refusal is on record                 only the provider's word
                                           (checkout_attempts)                        marks it paid
                                                                                                │
        After payment (back office + workers): stock issued ─► finance posted ─► picked/packed ─► dispatched/collected
        ─► delivered ─► (tax invoice + KRA when issued) ─► returns / credit notes / refunds. Every stage is on the order timeline.
```

## 1. Who takes part

| Who | What they can do |
|---|---|
| **Guest** | Browse, cart, check out, pay, track by link, look up an order by number plus the phone or email it was placed with. Cart and wishlist live in the browser. |
| **Customer (signed in)** | Everything a guest can, plus saved details and addresses filled in at checkout, "My orders", order details, a wishlist kept on the server, reviews (after a delivered order), their own pricing (price lists and groups are applied only for a signed-in customer). |
| **Credit customer** | May be offered "On account" (see edge case W1 before relying on it). |
| **Staff** | Everything after the order exists (admin screens, deliveries, riders, finance). Permissions are checked on the server. |
| **Workers** | Background jobs (section 12). |

## 2. Arriving

* The shop is `app/(store)/`. Its layout reads, in parallel and **awaited on purpose** (so a missing page can answer 404 and a redirect can redirect), the company, the shop currency, the names of the payment methods switched on, the categories and the signed-in name. Each read stands alone: if one fails the page still draws. **[code]**
* `StoreShell` draws the header, footer and three panels that open from them: **cart**, **track my order**, **help**. It also listens for realtime stock events and, after a burst of them, refreshes what is on screen once (2 s debounce). **[code]**
* The front page carries promo banners (streamed, so they never block), the shop, and an "About <company>" block built from the company's own data. Titles, descriptions, share cards and structured data are all built from company data ([seo.md](seo.md)).
* **Cart handed over from the business website:** `/checkout?handoff=<json>` (up to 16,000 characters, 100 lines, quantities above 0 and below 1,000,000, duplicates dropped). Each product is added through the normal cart rules, the cart is checked, and a message says whether anything changed. The URL is then cleaned. A bad handoff shows "We could not read the cart sent from the business website." **[code]**

## 3. Browsing and searching

All of it reads through `StorefrontCatalog`, which sees **live products only** (active, sellable, not deleted) and never returns cost.

* **Everything the shopper chooses is in the address** (`?q=&category=&min=&max=&stock=1&sort=&cursor=`), so a result can be shared and Back undoes it. Nonsense in the address is dropped, never rejected.
* **Paging is keyset** on (sort key, id) for the four orders (name, price up, price down, newest); a page costs the same however deep, and nothing repeats or skips if products change between pages. "Show more" appends in the browser and is also a real `rel="next"` link.
* **Search:** every typed word must be found in name, SKU, brand or category name (substring, trigram indexes) or as a whole word or word start in description and tags (stored `search_vector`). A category includes its sub-categories; an unknown or inactive category is an empty page, never "everything".
* **Filtered, sorted, searched and later pages are `noindex,follow`**; the plain shop and each category are indexable.
* **Prices on the page** come from the pricing engine (`withShopPrices`), not the product row: the same engine, lists and channel (`ecommerce`) as the order, for the signed-in customer if any. Each product is priced at the least that can be bought. If the engine cannot be reached the stored price is shown and checkout prices the order itself. **[code]**
* **Stock on the page** is what checkout will accept (`withShopAvailability`): while the per-location ledger is the truth, only the stock of locations that sell to the web shop counts. A **kit** is shown as "how many can be made" from its parts, "sold out" when a part is switched off, and at the tax rate its parts come to ([kits-and-hampers.md](kits-and-hampers.md)). **[tested]**

## 4. A product

`/product/<slug>`: the slug is the address; an old id link or an old slug answers **308** to the current one, a missing or unsellable product answers **404**.

* Gallery (always whole pictures, full-size viewer), price, stock badge ("Sold out", "Only N left" at or below the low-stock threshold, "In stock"), specifications, reviews, related and recently viewed products, a share button, a wishlist button, and on a phone a price-and-add bar once the main buttons scroll away.
* **Quantity** is counted in the product's own unit: whole pieces move by 1; goods sold by weight, length or volume move by 0.5 and can be typed exactly down to 3 decimals. An item's minimum and maximum order quantity start the stepper at the minimum and stop it at the maximum. **[tested]**
* **Add to cart / Buy now.** Outcomes, each in words: added; added up to what is in stock; added up to the most that can be bought; refused because sold out; refused because less is in stock than the least that can be bought. "Buy now" adds, then goes straight to checkout.
* **Reviews:** only a signed-in customer with a delivered or completed order for that product may write one; it is `pending` until a moderator publishes it; stars (and `aggregateRating`) appear only with at least one approved review. See [storefront.md](storefront.md).

## 5. The cart

* **The browser keeps only product ids, quantities and the price last seen** (`qsell_cart_v2`). The older key is read once and dropped. Another tab changing the cart updates this one.
* **On arrival and when checkout opens, every line is checked against the shop** (`reconcileCart`): current price and stock, withdrawn products removed, quantities cut to what is left or raised to the least that can be bought, price changes announced ("The price of X changed from A to B"). Nothing moves without a notice. If the shop cannot be reached the cart is kept and the shopper told prices are checked at checkout.
* **A price can depend on quantity** (price list breaks), so after a quantity changes the prices are read again quietly 400 ms later.
* **Packaging options** (items marked as checkout packaging) are offered in the cart and at checkout, with suggestions that fit the goods; the order refuses a packaging selection that does not fit.
* The cart drawer shows tax rows by tax category, and a hint to sign in. It is a dialog with focus handling and Escape.

## 6. The checkout form

Three numbered sections beside an order summary (a page, not a modal, `noindex`).

1. **Your details.** Name and phone are required; email is optional (a bad one is refused); tax PIN (KRA) is optional. A signed-in shopper's saved name, email, phone, PIN and addresses fill the form; a guest sees "Create account / Sign in" and may continue as a guest.
2. **Delivery address or Collection.** Saved addresses (signed in) or a written address (street, town, county, country). If the shop has delivery rules (section 6.1) the shopper also drops a pin or writes an area, chooses how it is delivered, and may name another recipient and leave a note for the rider.
3. **Payment method.** Only methods the company switched on appear, plus **On account** (shown to a credit customer with room, found by the signed-in email) and **Pay on delivery** (only for the shop's own riders, within the company's limit). A phone-based method also offers **"number to pay from"** (spouse's line, a work phone); empty means the contact number.

The summary shows the lines, tax rows, the delivery charge and the total. It adds `cartTotals(lines)` (client side, from the product's price and tax) to the delivery charge. Kits are shown at the blended tax rate of their parts so this equals the order (fixed 2026-11-07, **[tested]**).

### 6.1 Delivery at checkout ([delivery-module.md](delivery-module.md) §26 to §33)

* The shop offers a way of delivering only where a branch really offers it **and** a charge policy covers that branch. A shop with neither is unchanged (no delivery section, shipping 0).
* Methods: **own riders**, **courier**, **collect from a branch**. A pin (dropped on the map, searched by pressing Search, or the device location) or a written area tells the server which branch sends the order.
* After a 700 ms pause, whenever the place, method or basket changes, the browser asks the server for the charge (`shopQuoteDeliveryAction`): the basket is priced the way the order will be, kits broken into parts, the nearest branch that can cover it chosen, the charge worked out with tax, and "how this was worked out" shown. An answer to an earlier question is never shown for a later one. The browser sends only ids, quantities and the place; never a price, a branch or a charge.
* **Delivery times (slots)** are asked with the same question; the shopper may choose one but the order does not need one. A slot that has filled by the time the order is placed refuses it with a reason (`slot_unavailable`).
* **Collect from a branch:** only branches that hold every line are choosable; the order is addressed to the branch, the customer's saved address is not touched, a six-character collection code is made in the same transaction, and the customer finds it from the confirmation page or Track my order.
* **Pay on delivery** is offered only for own-rider deliveries and up to the company's limit; the server checks both again on the priced order.
* Rate limits: `shop_delivery_quote_ip` 120 per 10 min, `shop_map_search_ip` 40 per 10 min.

## 7. Placing the order (one server call)

`placeOrderAction` (`checkout-actions.ts`) answers **as data** (server-action errors are masked in production). Only refusals the shop wrote for the shopper (`CheckoutRefused`) are shown; anything else is logged and answered "We could not place your order just now…".

Order of work, each step able to refuse:

1. **Record the attempt** (`checkout_attempts`): time, a keyed hash of address and browser (never the address or phone), a summary of the cart. A refusal at any later point keeps its time, where it stopped and why.
2. **Read the input** (`parseCheckoutInput`): name, phone, optional email, optional PIN, address, delivery, payment method (from a fixed list), pay-from number (a phone method refuses anything that is not a Kenyan mobile number), up to 100 lines, quantities above 0 and at most 1,000,000, the same product twice is one line.
3. **Rate limit the payment prompt** (phone methods only): 20 per address and 4 per number per 15 min.
4. **Create the order** (`OrderWriteService.createOrder`), in this order:
   1. Read the products; check any packaging selection fits.
   2. Check each quantity against the product's unit; check minimum and maximum order quantities over the whole basket.
   3. **Price every line with the engine** (channel `ecommerce`, the signed-in customer only; an email typed in a form never unlocks another customer's prices). A line that cannot be priced refuses the order.
   4. **Discounts and coupons do not apply to the shop**: the discount engine runs only for staff channels, and the shop sends no coupon. Price floors likewise apply to staff channels only.
   5. **Kits are expanded** into one line per component, each with its share of the price, its own tax and its own stock; a switched-off component refuses the sale ([kits-and-hampers.md](kits-and-hampers.md)). Kits are read fresh from the database, not the 10-second cache.
   6. Work out subtotal and tax per line (tax-inclusive or exclusive per line).
   7. **Delivery:** plan the delivery on the server, compare the charge to the one the shopper was shown (`expectedCharge`); if it differs by more than half a cent the order is **refused and nothing saved** ("The delivery charge is now X and not the Y you were shown"); check the chosen slot; check pay-on-delivery rules. The delivery charge splits into net (the order's shipping fee) and tax (added to the order's tax).
   8. **Hold the stock** for inventory-managed lines (kits: per component). With the per-location ledger on, the hold is placed at a location chosen for the channel and branch; an online-payment order gets an **expiry** if the company set an unpaid-hold time (`unpaid_hold_minutes`; the default is 0, which means no expiry). Without the ledger the product counters are used and **never expire**. A short line refuses the order and leaves earlier lines untouched.
   9. **Find or make the customer** (`prepareSale`): by email, or by phone for a guest with no email; the card's name, phone and PIN are updated from what was typed (see edge case W2); a blocked customer is refused; "On account" requires a credit customer and checks the credit limit.
   10. Assign the dimension set, then **save the order, its lines, its delivery record, its collection code (if collecting), its slot request, its number from the sales-order series, and the first timeline event, in one transaction.** Also in the transaction: rebate accrual and loyalty points.
   11. Post the invoice to the customer's ledger (receivable) after the transaction.
   12. If anything in 9 to 11 fails, **the hold is released** and the error returned.
5. After a successful order: the stage `stock_reserved` is recorded, a realtime event is sent, and the admin order, customer and inventory pages and the shop front page are revalidated.
6. **Start the payment** unless the method is On account or Pay on delivery, which return "nothing to pay now".

**The cart is cleared as soon as the order is saved** (the order holds the stock), whatever happens to the payment.

## 8. Paying

| Method | What happens | Where "paid" comes from |
|---|---|---|
| **M-Pesa (STK)**, KCB Buni | A prompt goes to the phone (the pay-from number if given). The attempt is written before the request is sent. | Safaricom's confirmation, via the callback and a scheduled check with the platform. |
| **Card / Pesapal, Jenga** | A hosted page opens in a new tab; the shop waits. | The provider's answer. |
| **On account** | No payment now; the order is placed and the customer's ledger carries it. | Paid later on its invoice. |
| **Pay on delivery** | No payment now; the rider takes cash or M-Pesa at the door. | The rider's hand-in or door payment. |

* **`PaymentWait`** polls the attempt every 2.5 s, shows a 120 s countdown, and after it still waits ("Please do not start another payment: this page updates as soon as the provider answers"). It marks the order **paid only when the server says the attempt succeeded**; the browser never marks anything paid.
* **On success** (`PaymentService.succeed`): the attempt becomes successful; the order moves to `payment_confirmed` (payment status paid, order status processing, `paidAt` and `releasedAt` stamped); stock is issued (`fulfilOrder`: consumed now, or kept held until a delivery goes out or arrives when the company chose a later issue moment); the customer ledger is credited and the transaction reconciled when the provider's receipt number is known (without one the order is still paid and a person or the next check adds it).
* **On failure** (`PaymentService.fail`, callback or check): the attempt fails, the order moves to `payment_failed` (status **failed**), and **the stock hold is released**.
* **A payment that cannot even be started** records `payment_failed`, releases the hold, and shows "The payment could not be started" with a **Try again** button.
* **Try again** (`retryPaymentAction`) starts a new attempt for the same order (never a second order), optionally from another phone number, rate limited like the first. It does not hold the stock again (see edge case W3).
* The checkout page keeps all of this in memory: a refresh during the wait loses the page (the order is saved; find it with Track my order or My orders).

## 9. The confirmation

`OrderComplete` shows: "Thank you, your order is confirmed" (or "Your order is placed" for On account and Pay on delivery), the order number and payment reference, status, payment method and masked pay-from number, the delivery address or the collection panel with its code, total, a live progress list (the customer-facing stages, with times), and:

* **Download tax invoice** and **Email tax invoice** (the email goes to the address on the order).
* A reminder to keep the order number: follow it any time from Track my order or My orders.

**No confirmation email, receipt email or SMS is sent automatically at checkout.** The customer's emails are: account verification and password reset, the invoice when asked for, delivery progress messages (going out, delivered or part delivered, failed attempt with reason, return), newsletter confirmation. M-Pesa's own SMS is Safaricom's. **[code]**

## 10. After payment (back office and workers)

Everything below is on the **order timeline**: every stage has a server time, an actor, a source and (for failures) a reason ([order-stage-timeline.md](order-stage-timeline.md)). Staff move orders only through the one stage writer.

1. **Approval** (staff channels only; never for a shop checkout).
2. **Stock:** at payment by default; or when a delivery goes out; or when it arrives (needs the ledger) ([delivery-module.md](delivery-module.md) §30).
3. **Finance:** a queued job (`finance-post-sales`, every minute) posts the sale to the general ledger; payments are matched to receipts; receipts, credit notes, wallets and refunds follow the customer ledger.
4. **Fulfilment:** a delivery document is made (released, picking, packed, ready, out for delivery, delivered; a failed attempt can be tried up to 3 times, then returned), on a rider's run or with a courier; or the collection counter hands over against the code (5 wrong codes lock it; an ID check can override with a reason).
5. **Customer tracking:** every order has one link `/track/<token>` (24 random bytes, kept sealed and as a keyed hash, rate limited by address and link). It shows steps, contents and who received it; **never** an address, phone, price, rider or stock detail.
6. **Messages:** a delivery step queues a message in the same transaction; a sweep sends it (5 tries with growing waits).
7. **Tax invoice and KRA:** the tax invoice is **issued when its PDF is first generated** (by the shopper from the confirmation page or account, or by staff). That fixes its number (one per order and type; repeats return the same number) and starts KRA signing in the background, according to the customer's flag and the company's rules. It is not generated automatically at payment (edge cases W4, W5).
8. **Returns and refunds:** goods that come back after a sale are received against a credit note; a delivery that never reached the customer is returned to stock or the order; money goes back through the refund flow. See [core-finance-module.md](core-finance-module.md) and [delivery-module.md](delivery-module.md) §31.

## 11. The account side

* **Register** (`/register`, also as a modal over the shop): name, email, password (policy checked on the server), rate limited 10 per hour per address. No session is made until the address is verified from the emailed link. **Sign in** is rate limited per address (100 per 15 min) and per account (8 per 15 min); an unverified account is told so only after the password matched. **Password reset** and **resend verification** are mailed (3 per hour per account, 10 per address) and answer the same whether or not the address exists.
* **My orders / order details** (`/profile/orders`, `/profile/orders/[id]`): the owner is taken from the session only; an order that is not theirs is "not found".
* **Addresses:** add, edit, delete, make default; all scoped to the signed-in customer's own record.
* **Wishlist:** server-side for signed-in shoppers (capped at 200), in the browser for guests, merged once at sign-in; a share link can be made.
* **Newsletter:** double opt-in; asking only creates a pending row and sends a confirmation link; the link opens a page with a button (mail scanners open links). 3 per hour per email.
* **Help, policies, platform** pages are built from the company's own content.

## 12. The clock: what runs in the background

| Job | Every | Does |
|---|---|---|
| `stock-reservation-expiry` | minute | Releases holds whose time passed (only online-payment orders when `unpaid_hold_minutes` > 0, ledger mode); marks the unpaid order `payment_failed` ("hold_expired"). |
| `provider-sweep`, `provider-pull-sweep` | minute, 10 min | Picks up half-finished payments; compares with what the provider received. |
| `finance-post-sales` | minute | Posts queued sales to the ledger, retrying failures. |
| `delivery-messages-sweep` | minute | Sends queued customer delivery mails. |
| `delivery-sla-scan`, `order-sla-sweep` | minute, 5 min | Raises late deliveries and orders held too long in a stage (for example payment not confirmed after 30 min, paid but not dispatched after 24 h). |
| `order-stage-backfill` | 5 min | Rebuilds timelines for old orders. |
| `purge-checkout-attempts` | daily | Removes old attempt records. |
| `wallet-expiry`, `expire-loyalty-points`, `expire-gift-cards` | daily | Lapses unused credit, points and gift cards. |
| `currency-sync-rates` | hourly | Keeps the shop's display rates equal to the books' rate. |

## 13. Money, tax and currency

* The shop shows **one currency, the base currency** (`resolveBaseCurrency`). `placeOrderAction` never sends a currency, so a web order is always in **KES**. The `USD` option exists inside the order service for other channels.
* Tax is per line, from the product's rate and "price includes tax" flag, then summed (`computeCheckoutTotals`). Kits are taxed part by part. Delivery tax is added to the order's tax.
* Totals: subtotal + tax + shipping. The delivery charge is the order's shipping fee (net) with its tax in the order's tax.
* Rounding: line and order amounts to the cent; the delivery charge compared to the cent.

## 14. Limits and protections at a glance

| Place | Protection |
|---|---|
| Every shop action | Input parsed on the server; the browser is never trusted for money, stock or identity. |
| Payment prompts | 20 per address, 4 per phone, per 15 min. |
| Sign in / register / mail forms | See section 11. |
| Delivery quote and map search | Per address (section 6.1). |
| Tracking page | 60 per address, 40 per link, per 10 min. |
| Collection code look-up | 30 per address, 8 per order number, per 10 min. |
| Reviews / newsletter | 10 per hour per person; 10 and 3 per hour. |
| Payment callbacks | Unguessable per-attempt secret in the address; the provider's payment is checked with the platform before an order is paid. |
| Links in emails | Built from configuration, never from the request's Host header. |
| Order placement | **No rate limit of its own** (edge case W6). |
| Order look-up by number and contact | **No rate limit** (edge case W7). |

## 15. Edge cases

Severity: **High** can lose money or expose data; **Medium** gives wrong results in a plausible case; **Low** is a rough edge.

**W1 [ran] High. A stranger can charge a credit customer's account.** "On account" is hidden for anyone who is not signed in as that customer, but the server does not check. `placeOrderAction` accepts `paymentMethod: 'on_account'` from anyone; `prepareSale` finds the customer **by the email typed in the form**; if that card is a credit customer within its limit, the order is placed on their account. I ran it: a guest typing a credit customer's email placed an order on account (the customer's balance rose by the total). **Fix:** for On account, require a signed-in session whose customer is the credit customer; never find a credit card by a typed email. 

**W2 [ran] High. A guest order overwrites an existing customer's card.** For an existing email, `prepareSale` saves the typed name, phone and KRA PIN onto the customer's card **before** any check, and it stays saved even when the order is then refused. I ran it: after a guest order with the victim's email the card's name and phone were the guest's. It also tells a stranger whether an email belongs to a customer (the refusal "… is a cash customer and must pay at the invoice" versus success). **Fix:** only a signed-in session may update a card; a guest order must make or reuse a card without touching a registered customer's name, phone or PIN.

**W3 [ran] High. Paying again after a provider-reported failure sells stock that was released.** When the provider reports a failed payment, the order's hold is released and the screen offers "Try the payment again". Retrying does not hold the stock again. If the retry succeeds, `fulfilOrder` finds nothing held and nothing is issued: I ran place (on hand 5, held 2), fail (5, 0), then paid (5, 0): the order is paid and **the 2 units never leave stock**, so they can be sold again. The ledger-mode path (holds already `released`) behaves the same by code. **Fix:** a retry must re-hold the stock first (and be refused if it cannot), or a failed order must not offer a retry after its hold is released.

**W4 [code] Medium. The tax invoice and KRA signing happen only when someone asks for the PDF.** There is no automatic issue at payment. A shopper who never downloads or emails it, and staff who never open it, leave a paid order without a tax invoice number and without a KRA submission. **Fix:** issue (and sign) the tax invoice when the order is paid and released for fulfilment, and let the shopper only fetch it.

**W5 [code] Medium. A tax invoice can be generated for an unpaid, failed or cancelled order.** `generateInvoicePdfAction(orderId)` is public and refuses only an order waiting for approval (and a proforma for a paid one). Anyone holding an order id can number and send for signing a fiscal document for an order that was never paid. The order id is unguessable but is in the confirmation page and used as the only key. **Fix:** a tax invoice needs a paid order (or on account or pay on delivery, once released).

**W6 [code] Medium. Nothing limits how many orders a visitor can place, and unpaid stock holds do not expire by default.** The checkout records every attempt but only the payment prompt is rate limited. One visitor can place orders (or "Pay on delivery" orders, which start no payment) for all the stock; `unpaid_hold_minutes` defaults to 0 (no expiry), and without the ledger holds never expire. **Fix:** a per-address and per-contact rate limit on order placement; a sensible default hold time; pay-on-delivery orders expire if not released in time.

**W7 [code] Medium. Looking up an order by number and contact is not rate limited.** `lookupOrderAction` and `confirmedOrderAction` return the whole order (items, address, totals) for an order number plus an exact email or phone. Order numbers follow a visible series. The tracking page and the collection look-up are rate limited; these two are not. **Fix:** the same two-key limit as collection look-up (per address, per order number), and return less.

**W8 [code] Medium. `createOrderAction` and `createCheckoutOrderAction` are public server actions that skip the checkout's protections.** They call the order service directly: no checkout attempt record, no rate limits, no pay-from phone checks, and they accept any payment method (including On account, W1). The shop screen does not use them. **Fix:** remove them, or call the same entry as the screen.

**W9 [code] Medium. Starting a payment needs only an order id.** `initiateBranchPaymentAction` and `retryPaymentAction` take an order id; the first has no permission check, the second only a rate limit. The prompt goes to the number the order holds, so the harm is bounded (an unwanted prompt to the buyer, capped at 4 per number per 15 min on retry), but anyone holding an id can start payments. `getPaymentAttemptStatusAction(attemptId)` is likewise public and returns the receipt number for any attempt id. **Fix:** require the proof the lookup uses (order number plus contact) or a signed token.

**W10 [code] Medium. A failed payment makes the order status `failed`, and a retry that succeeds makes it `processing`.** The timeline shows both. Reports that count failed orders count orders that were later paid.

**W11 [code] Medium. Online-payment holds can run out under a later payment.** With a hold time set (ledger mode), a customer who pays after the hold expired has the stock released and the order marked `payment_failed`; a late successful payment then repeats W3 (paid, nothing issued). Same fix.

**W12 [code] Medium. A web order is always KES, whatever the shop shows.** If a company sells in a base currency other than KES the order still says `KES`. It is not an issue for a KES shop.

**W13 [code] Low. The checkout state is in memory.** Refreshing during the payment wait, or closing the tab, loses the page. The order is saved, the cart is already cleared, and the customer must use Track my order or My orders. There is no automatic message (no confirmation email, no SMS) to tell them it went through (section 9).

**W14 [code] Low. Where a guest's pricing is concerned, only a signed-in customer gets their own prices.** A guest known by email to be a wholesale customer pays the public price. That is intended (an email typed into a form must not unlock prices), but the customer should sign in.

**W15 [code] Low. Guest customers with no email are matched by phone.** A second guest with the same phone and no email lands on the same card, and each order overwrites its name.

**W16 [code] Low. Search ignores spelling mistakes and word order beyond "every word must appear".** No synonyms, no fuzzy match.

**W17 [code] Low. The cart can hold a line the shop later stops selling.** It is removed with a notice when the cart next loads, or refused at checkout with "Something in your basket is no longer for sale".

**W18 [code] Low. Packaging selection is only validated for the shop channel,** and only when a packaging product is in the order.

**W19 [code] Low. The pay-from number is rate limited by number, not by order.** Four retries per 15 min per number stand even if they are for different orders.

**W20 [by design] Discounts, coupons and price floors do not apply to web orders.** Promotions run on the staff channels; the shop takes the engine's price. If the company expects shop promotions, they are not applied (and the shop sends no coupon). A customer-specific price on the shop comes from the price lists only.

**W21 [by design] Collecting an order does not expire it,** and the code is not emailed. The customer sees it on the confirmation page and in Track my order.

**W22 [by design] The order summary on screen is computed in the browser** from the product's price and tax, and the server prices again on placement. They agree for normal baskets; a basket with a price-list quantity break, or a product changed in the seconds between, can differ by the new price. The checkout then refuses only for a delivery charge change; a changed product price is charged at the server's price (the shopper saw the cart refresh at checkout open).

## 16. What is tested and what is not

**Tested** (unit, integration, e2e): the storefront catalog and its indexes, quantity and unit rules, cart reconcile, checkout input parsing, the pay-from phone, delivery quote at checkout, pickup and the collection code, slots, pay on delivery, stock availability for the shop, kits at checkout, order timeline and checkout attempts, guest checkout without an email, account pages, wishlist, reviews, newsletter, tracking page, SEO tags. E2E files: `storefront`, `storefront-account`, `storefront-engagement`, `storefront-specifications`, `checkout-payment-phone`, `delivery-checkout`, `delivery-pickup`, `delivery-slots`, `customer-tracking`, `quantity-limits`, `stock-timing`, `order-timeline`, `wishlist-*`, `seo`.

**Not covered by a test I found:** a retry after a reported failure (W3); On account by a signed-out visitor (W1); a guest updating an existing card (W2); issuing an invoice for an unpaid order (W5); placing many orders (W6); order look-up limits (W7); the handoff cart with an unavailable product end to end; the hold expiry followed by a late payment (W11).

## 17. Not built

* Order confirmation or payment receipt email or SMS at checkout.
* Automatic tax invoice at payment.
* Shop promotions and coupons.
* Abandoned-cart recovery.
* A saved cart on the server for signed-in shoppers (the cart is per browser).
* Multiple currencies on the shop.
* Sending the newsletter (the list and its opt-in exist).
* A wishlist or cart that follows a guest between devices.
