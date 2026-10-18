ALTER TABLE "gift_cards" ADD COLUMN "funded_by" text DEFAULT 'unspecified' NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD COLUMN "funding_method_id" uuid;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_funding_method_id_payment_methods_id_fk" FOREIGN KEY ("funding_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- A gift card handed out, or points given, is money the business owes the moment it happens. The database queues it for the
-- books when the card or the points are written down, so no way of issuing them can be missed. Nothing is queued before the
-- general ledger is live: what is owed on that day comes in as an opening balance.
CREATE FUNCTION finance_queue_gift_card_posting() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IN ('issue', 'adjust') AND NEW.amount <> 0 THEN
    INSERT INTO finance_sales_postings (company_id, kind, subject_id, event_date)
    SELECT c.company_id, CASE WHEN NEW.kind = 'issue' THEN 'gift_card_issue' ELSE 'gift_card_adjust' END, NEW.id::text, (NEW.created_at AT TIME ZONE 'Africa/Nairobi')::date
    FROM gift_cards c
    JOIN finance_settings s ON s.company_id = c.company_id AND s.sales_gl_go_live IS NOT NULL
    WHERE c.id = NEW.card_id
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER gift_card_ledger_to_books AFTER INSERT ON "gift_card_ledger" FOR EACH ROW EXECUTE FUNCTION finance_queue_gift_card_posting();--> statement-breakpoint
CREATE FUNCTION finance_queue_loyalty_posting() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IN ('earn', 'reverse_earn', 'expire', 'adjust') AND NEW.points <> 0 THEN
    INSERT INTO finance_sales_postings (company_id, kind, subject_id, event_date)
    SELECT NEW.company_id, 'loyalty_change', NEW.id::text, (NEW.created_at AT TIME ZONE 'Africa/Nairobi')::date
    FROM finance_settings s
    WHERE s.company_id = NEW.company_id AND s.sales_gl_go_live IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER loyalty_ledger_to_books AFTER INSERT ON "loyalty_ledger" FOR EACH ROW EXECUTE FUNCTION finance_queue_loyalty_posting();
