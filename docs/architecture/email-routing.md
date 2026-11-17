# Email routing: who gets which mail, and who a customer can reach

**Status:** decisions taken 2026-11-16, slices E-0..E-5. **Owner:** Settings (Company Setup, Support channels), with Quotes, Orders and the web shop as users of it.

## 1. Why

Today every business mail goes to one place: the shopper (quotes, orders) or the company's single address. Companies need to say, per kind of mail, **who is written to** (several staff), **who is copied** (Cc), **who is blind-copied** (Bcc), **where a customer's reply goes** (Reply-To, one or many), and **which business emails the customer sees on the quote** so they can reach the right people. All of it is configuration, changed in the admin console without a release, with a default that works with no setup.

Replies are not captured in the app (that belongs to the CRM later); Reply-To only carries them to the right inboxes.

## 2. Points

A **point** is one place the system writes a mail. Each is a row in a registry in code (`domain/email-points.ts`); a deployment does not add points, it configures them.

| Point | What it is | Default if never configured |
|---|---|---|
| `shop_quote_request_staff` | A shopper asked for a quote on the web shop (alert to the team) | To: the company's own address |
| `shop_quote_request_customer` | The confirmation to that shopper | To: the customer |
| `quote_sent` | A quote emailed from Sales Quotes to the customer | To: the customer; Reply-To: the company's own address |
| `shop_order_placed_customer` | The shopper's "we have your order" mail | To: the customer |
| `shop_order_paid_customer` | The shopper's "payment received" mail | To: the customer |
| `shop_order_placed_staff` | New: the team is told an order was placed | **Off** until configured |
| `shop_order_paid_staff` | New: the team is told an order was paid | **Off** until configured |
| `quote_document_shop`, `quote_document_staff` | Not a mail: the business emails printed on the quote document for quotes that came from the shop / were made by staff | The company's own address (what is printed today) |

A point can be switched off (no mail is sent; the reason is logged).

## 3. Recipients are sources, resolved when the mail is sent

A recipient list (To, Cc, Bcc, Reply-To, and the "shown on the quote" list) is a list of **sources**. A source says *where to find* an address, so a change in Company Setup or in a person's account follows automatically:

| Source | Resolves to |
|---|---|
| `staff` (a user) | That staff member's current account email; skipped when the account is suspended or gone |
| `company` | The company's own email from Company Setup |
| `channel` (a support channel) | An email channel added in Company Setup → Support (for example "Sales desk") |
| `customer` | The customer on the document (the shopper, the quote's customer) |
| `actor` | The staff member who pressed the button (who sent the quote) |
| `owner` | The staff member who made the quote (not present on a quote a shopper asked for) |
| `address` | A typed address, for the odd one-off |

Rules, all in one pure module (`domain/email-routes.ts`): every address is validated (a deliverable address, not `@localhost`); duplicates are removed ignoring case, and an address that is in To is not repeated in Cc or Bcc, nor one in Cc in Bcc; each list is limited (20); a source that cannot be resolved is *skipped and reported* (never an error that stops the mail); if **To** ends up empty the mail is not sent and the log says why. Reply-To may name many addresses.

## 4. Storage

`email_routes` (company, point, version, `config` jsonb, updated by and at; unique on company and point). The jsonb is read through the pure `resolveRoute`, which fills defaults and drops anything invalid, so a bad row can never break a send. Changes go through one service that checks the permission, validates, bumps the version and writes the decision log.

`sales_quotes.contact_emails` (jsonb, null): a quote's own list of business emails shown on it, chosen when editing the quote; null means "use the default for its flow".

## 5. The mail port

`EmailMessage` gains `cc`, `bcc` and a Reply-To that may be many, plus `toMore` for further To addresses (`to` stays the first, so existing callers and test doubles are unchanged). The SMTP adapter puts every address in the envelope; Bcc is never shown. The deployment's From policy is unchanged.

## 6. The quote document

The quote PDF, the public quote page and the quote email say "Questions? Contact …" with the resolved *shown on the quote* list of the quote's flow, or the quote's own list when it has one. A quote that has none resolves to the company address, as before.

## 7. Admin

`Settings → Email routing` (`/admin/settings/email-routing`), behind its own permission `email_routing:manage` (read: `email_routing:read`). One card per point: on/off, and To, Cc, Bcc, Reply-To (and, for the quote document points, Shown on the quote) each as a list of chips with an *Add* that chooses the kind of source then the person or channel. Staff and channels are picked from the shared lookup pickers (never `<select>`, never the whole list). Each card shows **who it would go to now** (a server preview using sample context), and warns when To would be empty. Saving needs a reason like other settings. The quote editor gets **Business contacts on this quote** (override).

## 8. Slices

| Slice | What |
|---|---|
| **E-0** | The mail port: Cc, Bcc, many To and Reply-To; adapters; sender policy; tests |
| **E-1** | Registry of points, pure source resolution, `email_routes` table and service, tests |
| **E-2** | Admin screen with permission, pickers, preview; lookups for staff and channels |
| **E-3** | Wire the points: shop quote request (staff and shopper), quote sent, shop order mails (customer and the two new staff alerts) |
| **E-4** | Quote document contacts: PDF, public page and email; per-quote override in the editor |
| **E-5** | My quote requests in the shopper's account |
| **Docs** | Implementor guide in every slice; platform SEO registry untouched (admin only) |

## 9. Built

All slices are built. The mail port takes `cc`, `bcc`, `toMore` and many Reply-To addresses (E-0). `domain/email-points.ts` and `email-routes.ts` are the registry and the pure rules; `email_routes` (migration 0182) and `EmailRouteService` store, resolve, label and change them with a reason and the decision log (E-1). The screen is `/admin/settings/email-routing` behind `email_routing:manage`, with lookup sources `email-routing-*` (and `quote-contact-*` for the quote editor, behind `quotes:update`) (E-2). The senders use `emailRoutes.resolve` for the shop quote request mails, the quote email, and the shop order mails; the two staff order alerts are new jobs (`shop-order-email` with `audience: 'staff'`) (E-3). The quote document prints `quoteContacts` (PDF, public page, email), and `sales_quotes.contact_emails` holds a quote's own list (E-4). `/profile/quotes` lists the shopper's own requests (E-5).

## 10. Not in scope

Capturing replies in the app (CRM), per-customer routing, sending from different mailboxes per point (the deployment's mailbox and From policy still decide that), rules by order amount or branch (a later refinement of the same sources).
