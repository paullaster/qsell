ALTER TABLE "customer_wallets" ADD COLUMN "base_value" numeric(18, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD COLUMN "rate" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD COLUMN "base_amount" numeric(18, 4) DEFAULT '0' NOT NULL;
--> statement-breakpoint
-- What each movement was worth in the books' currency. A wallet in that currency is worth what it holds. Money that came in
-- from a receipt in another currency was posted at that receipt's rate; anything else that already exists is valued at 1 (no
-- foreign wallet could be used or written off before this).
ALTER TABLE "wallet_entries" DISABLE TRIGGER wallet_entries_append_only;--> statement-breakpoint
UPDATE "wallet_entries" e SET
  rate = x.rate,
  base_amount = ROUND(e.amount * x.rate::numeric, 4)
FROM (
  SELECT we.id,
         CASE WHEN s.base_currency IS NULL OR upper(we.currency) = upper(s.base_currency) THEN '1'
              ELSE COALESCE((SELECT cr.rate FROM customer_receipts cr WHERE cr.ledger_entry_id = we.ledger_entry_id LIMIT 1), '1') END AS rate
  FROM "wallet_entries" we
  LEFT JOIN finance_settings s ON s.company_id = we.company_id
) x
WHERE x.id = e.id;--> statement-breakpoint
ALTER TABLE "wallet_entries" ENABLE TRIGGER wallet_entries_append_only;--> statement-breakpoint
UPDATE "customer_wallets" w SET base_value = COALESCE((SELECT SUM(base_amount) FROM "wallet_entries" e WHERE e.wallet_id = w.id), 0);
