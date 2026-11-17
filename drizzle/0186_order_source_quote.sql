ALTER TABLE "orders" ADD COLUMN "source_quote_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_quote_id_sales_quotes_id_fk" FOREIGN KEY ("source_quote_id") REFERENCES "public"."sales_quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_source_quote_idx" ON "orders" USING btree ("source_quote_id") WHERE "orders"."source_quote_id" IS NOT NULL;--> statement-breakpoint
-- Orders already made from a quote are linked to it (the quote has always known its order).
UPDATE "orders" o SET "source_quote_id" = q."id" FROM "sales_quotes" q WHERE q."converted_order_id" = o."id" AND o."source_quote_id" IS NULL;
