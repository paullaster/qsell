ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "stock_code" text;--> statement-breakpoint
-- Backfill from each existing unique SKU before enforcing the new constraints.
UPDATE "products" SET "stock_code" = 'STK-' || "sku" WHERE "stock_code" IS NULL;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "stock_code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_stock_code_uidx" ON "products" USING btree ("stock_code");
