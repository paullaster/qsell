-- Trigram indexes need this extension; it ships with PostgreSQL and the database owner may create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "products_shop_name_idx" ON "products" USING btree ("name","id") WHERE "products"."is_active" and "products"."is_sellable" and "products"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "products_shop_price_idx" ON "products" USING btree (coalesce("price", 0),"id") WHERE "products"."is_active" and "products"."is_sellable" and "products"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "products_shop_newest_idx" ON "products" USING btree ("created_at","id") WHERE "products"."is_active" and "products"."is_sellable" and "products"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "products_name_trgm_idx" ON "products" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_sku_trgm_idx" ON "products" USING gin ("sku" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_brand_trgm_idx" ON "products" USING gin ("brand" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_category_name_trgm_idx" ON "products" USING gin ("category_name" gin_trgm_ops);