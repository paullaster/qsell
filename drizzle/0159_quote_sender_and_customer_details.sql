-- A quote shows the customer's details by default now; the box on the quote hides them. Quotes already saved keep what they had.
ALTER TABLE "sales_quote_templates" ALTER COLUMN "show_billing_address" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "sales_quotes" ALTER COLUMN "show_billing_address" SET DEFAULT true;--> statement-breakpoint
-- Who emailed the quote to the customer, kept beside when it was sent.
ALTER TABLE "sales_quotes" ADD COLUMN "sent_by" text;--> statement-breakpoint
UPDATE "sales_quotes" q SET "sent_by" = e."actor_id"
FROM (
  SELECT DISTINCT ON ("quote_id") "quote_id", "actor_id"
  FROM "sales_quote_events"
  WHERE "event_type" = 'sent' AND "actor_id" IS NOT NULL
  ORDER BY "quote_id", "created_at" DESC
) e
WHERE e."quote_id" = q."id" AND q."sent_at" IS NOT NULL;
