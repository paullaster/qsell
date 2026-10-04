DROP INDEX "products_sku_uidx";--> statement-breakpoint
DROP INDEX "products_stock_code_uidx";--> statement-breakpoint
DROP INDEX "products_slug_uidx";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_uidx" ON "products" USING btree ("sku") WHERE "products"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_stock_code_uidx" ON "products" USING btree ("stock_code") WHERE "products"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_uidx" ON "products" USING btree ("slug") WHERE "products"."deleted_at" is null;