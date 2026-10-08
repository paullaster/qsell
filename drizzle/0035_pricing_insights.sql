ALTER TABLE "order_items" ADD COLUMN "unit_cost" numeric(14, 4);--> statement-breakpoint
CREATE INDEX "discount_usage_occurred_idx" ON "discount_usage" USING btree ("company_id","occurred_at");