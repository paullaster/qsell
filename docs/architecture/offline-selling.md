# Offline selling at the counter (O-0..O-5)

**Status:** decisions taken 2026-11-18 on the owner's instruction ("I want it done"), defaults chosen where the owner left the choice open; **built** (O-0..O-5) with the changes in section 10. **Owner:** Selling documents (Cash Sales and Shifts).

## 1. Why

A till that stops when the connection drops loses sales. This lets a cashier **keep ringing up cash sales with no connection** and brings every one of them into the books safely when the connection returns: no sale lost, none counted twice, nothing sold that the company did not allow, and every difference shown for a person to look at.

It is **off by default** and is turned on and off only through its own setting, behind its **own permission** (`offline_selling:manage`), which no other permission includes. Turning it on is the company accepting what section 6 says about receipts.

## 2. What can be sold offline

**Cash sales only**, by a person who **opened a shift while online**. Everything that needs the server's judgement stays online: opening and closing a shift, returns, credit sales, quotes, prices set by rules (price lists, discounts, coupons, quantity breaks), packages that need their builder, and a customer other than the walk-in customer. Offline the screen says so, in words, next to the thing that is unavailable.

## 3. How it works

1. **While online**, the till page keeps in the browser (IndexedDB) a **catalogue snapshot** of what this till may sell (product, SKU, name, the price as the server worked it out for a walk-in cash sale, tax included, whether it takes decimals, what is offered in cash sales), refreshed at start and every few minutes, and the **shift token** (section 5).
2. **Offline**, the page (kept by a service worker so it opens with no connection) sells from the snapshot: add products, take cash (with change), M-Pesa or card as the cashier records them. Each sale is written to an **outbox** in the browser with its key, the lines with the prices shown, the tenders, the shift, the time on the device, and a **device receipt reference** the customer is given.
3. **When the connection returns**, the outbox is sent in order, one sale at a time. Each is checked, turned into a real cash sale, and answered with its **real receipt number**. A sale the server cannot accept is not dropped: it is kept in the outbox with the reason in words and shown in **Needs attention**.

## 4. Prices, stock and what the customer already paid

- **The customer paid the price on the slip, so the sale is accepted at that price**, not re-priced. The server compares it with the price it would charge now and records any difference on the sale (`offline_review`: *price differs*) for a person to look at. It never charges the customer more.
- **Stock**: the goods have already left. A sale whose stock is no longer there is still accepted; stock is allowed to go negative for it (a one-off allowance for the sync, not a setting of the location) and the sale is flagged *stock was short* so the shortage is counted and put right, never hidden.
- **A product no longer offered in cash sales, or switched off**, is accepted all the same (it was sold) and flagged *no longer sold*.

## 3a. Limits that keep it honest (set with the setting)

- **Most that can be sold offline in one shift** (KES; built in 50,000) and **longest an offline sale may wait to be sent** (hours; built in 24). A sale over either is **refused at the till** (the page stops selling offline when the shift's offline total would pass the limit) and **refused by the server** on sync, with the reason.
- **No sale into a closed shift**: a shift cannot be closed while any of its offline sales are still in a browser. The close is refused saying so ("2 sales are still to be sent from this till"), and a supervisor may discard them with a reason (recorded).

## 5. Tamper resistance

The outbox lives in the browser, so it is not trusted. When the shift is opened (online) the server issues a **shift token**: a random secret kept with the shift, plus a per-sale **signature** the page computes over the sale (key, lines, prices, tenders, time) with a key derived from it. On sync the server **recomputes the signature**; a sale whose content was changed after it was rung up is **rejected as tampered**. Sale keys are unique (a repeat changes nothing), the shift must be the sender's own and open at the time the sale was rung up, the device time is kept beside the server's (never used for order), and every acceptance, price difference and rejection is in the decision log. A stolen token only ever lets someone submit sales into that one shift, within the limits above.

## 6. Receipts and the tax invoice (what turning it on means)

An offline sale cannot take a number from the gap-free fiscal series, and cannot be signed with KRA until it is sent. So the customer leaves with a **provisional slip** carrying the device reference and the words "tax receipt to follow". On sync the sale becomes a normal cash sale: the **real receipt (tax invoice) is numbered from the POS series and signed as for any cash sale**, and staff can reprint it for a customer who returns. **The company decides, by switching this on, that this is acceptable for it**, and the setting says so in plain words next to the switch.

## 7. Data

`offline_selling_settings` (company, enabled, max offline per shift, max hours, version, updated by and at); `shifts.offline_secret` (sealed, set at open); `offline_sales` (sale key unique, shift, order, status `accepted | needs_review | rejected`, reasons, device receipt reference, device time, received time, content hash); a trigger refuses any change to an accepted row except its review marks. Indexes: by shift, by status for the review list.

## 8. Slices

| Slice | What |
|---|---|
| **O-0** | The setting and its permission and screen; pure rules (limits, signature, outbox order) and their tests |
| **O-1** | Server: shift token, the sync action that accepts one offline sale (signature, limits, fixed prices, stock allowance, review flags), idempotent, with database tests |
| **O-2** | The close guard (shifts with sales still to send) and the supervisor discard |
| **O-3** | The browser: catalogue snapshot, outbox, device receipt, signing; pure and unit-tested |
| **O-4** | The offline till page and the service worker; sync, *Needs attention*; browser tests with the connection cut |
| **O-5** | Review screen for flagged sales; implementor guide; SEO/nav entries |

## 9. Not in scope

Offline returns, offline opening or closing of a shift, offline for credit customers, a second till taking over another's outbox, and printing to a receipt printer without the browser's print dialog.

## 10. As built (changes from the design above)

- **Stock that is not there is parked, not forced.** The design said to accept the sale and let stock go negative. Stock never goes negative in this system, so a sale whose stock is short is **kept whole** (`offline_sales.status = parked`, with its payload) and shown to a person; the shift **cannot be closed while one is parked**; once the stock is put right a supervisor presses *Try again* and it is made as the shift's owner from what was received, or gives it up with a reason. Nothing is lost.
- Setting: `offline_selling_settings`; permission `offline_selling:manage` (held by no other permission); screen *Settings → Offline selling* with the plain-words statement of what switching it on means, a reason for every change, the decision log.
- Server: `OfflineSaleService` (snapshot, ingest, review, retry, discard, acknowledge); `offline_shift_keys` (the shift's secret, sealed with the platform's data key); `offline_sales` (a trigger refuses any change to what was received and any delete); signing is HMAC-SHA256 over a canonical text (`offline-rules.ts`), the same on the till (WebCrypto) and the server. A sale is checked in this order: switched on, readable and its total equal to its lines, the sender's own shift, a repeat (answered from what was kept), the shift open, the signature, the limits, then made through the normal cash sale with the customer's prices fixed (`quotedItems`/`quotedTotals`) and the offered-in rule skipped (flagged instead).
- Browser: `lib/offline-till` (IndexedDB store, outbox rules that are pure and unit-tested, signing, getting ready), `public/offline-till-sw.js` (keeps only the till page and this site's built files, never a server answer), `OfflineTillClient`, `OfflineReview`; the Shifts screen refuses to close a shift while sales are waiting on that till.
- Migration 0195.
