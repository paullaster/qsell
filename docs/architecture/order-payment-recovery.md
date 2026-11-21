# A customer finishes the payment of an order that did not complete

Design note, 2026-11-21. Implementor guide: `implementor-guide/14-external-portals-customer-rider-vendor.md` (Part A, section 5; actions 1A and 1B; the rules under section 7).

## The problem

A shopper paid and has the provider's message with a transaction code, but the shop never heard back (a missed callback, a lost network, a provider outage). The order sits unpaid. The shopper needs a way back to that order that is safe: nothing on the order may change, and money is never counted on the shopper's word.

## The flow

1. An unpaid order shows **Payment not received** with **Complete this order** (account order page and tracking page). The page behind it shows the order read only, with two choices.
2. On opening, `PaymentClaims.refresh` re-reads the order's own checkout payments (M-Pesa STK query, Pesapal status, and so on) through the existing `PaymentVerificationService.verifyAttempt`. A missed callback is often all that is wrong, and then the order is simply paid.
3. **I have already paid.** `PaymentClaims.start` records a `payment_attempts` row with `source = 'customer_claim'` and the code, then (M-Pesa) starts a Daraja Transaction Status operation for the code with its own idempotency key. The answer arrives on the provider's secret result address as for every operation; `PaymentVerificationService.verifyClaim` reads it through the adapter's `verifyClaim`, and a `confirmed` outcome settles through the same `PaymentService.succeed` as any payment, so the order stage, the receipt and the ledger follow.
4. **Pay again.** `recoveryPayAgain` re-reads earlier payments first, refuses a second prompt within 90 seconds of the last, re-holds the stock, and starts a payment through the existing `startPayment`.

## What makes it safe

- Nothing the browser sends about the order or its money is used; the amount is `amountDue(order)`.
- Access is the existing proof: the signed-in owner (`ownsOrder`), or the tracking link (looked up and limited like the tracking page).
- The provider's own record must agree on: completed, the code, the amount, our shortcode, made after the order was placed. One provider transaction settles one payment (the transaction store, plus a unique index on `(provider_code, claimed_receipt)` while a claim is alive).
- A payer phone that the order does not know holds the claim for a person (`PAYER_DIFFERS`); it is never counted by itself.
- A claim that fails marks only the claim failed, with a timeline entry (`payment_pending_verification`, outcome `failed`, with the reason); `PaymentService.fail` does not move the order or release its stock for a claim.
- Rate limits per order and per address (`payment_claim_order`, `payment_claim_ip`, `payment_refresh_order`).

## Providers

`verifyClaim` is an optional method of `PaymentPort`. Only M-Pesa (Daraja Transaction Status) implements it, because it is the only provider here with a documented way to look a payment up by the shopper's code. For the others the code is kept for a person, the order's own payments are re-read, and the shopper is told so. A provider gains the full flow by implementing `verifyClaim` and being listed in `LOOKUP_BY_CODE` (`src/lib/payment-claim.ts`).

## Data

Migration 0207: `payment_attempts.source` (`checkout` | `customer_claim`, checked), `claimed_receipt` (set exactly when the source is a claim, checked), and the partial unique index above.

## Not done

- Staff already confirm an attempt by hand from Payments, then Activity (`confirmAttemptManually`, with the provider's code and a reason). A claim held for a person is a pending attempt, so it appears there once it is 30 minutes old (the list's existing rule). A dedicated queue for held claims that shows at once, and a message to staff when one is held, are not built.
- A claim for Pesapal, Jenga or KCB is only kept; no automatic lookup exists for them.
