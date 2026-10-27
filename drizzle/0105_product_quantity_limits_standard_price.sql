ALTER TABLE "products" ADD COLUMN "standard_price" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "min_order_qty" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "max_order_qty" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_min_order_qty_chk" CHECK ("products"."min_order_qty" IS NULL OR "products"."min_order_qty" > 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_max_order_qty_chk" CHECK ("products"."max_order_qty" IS NULL OR "products"."max_order_qty" > 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_order_qty_range_chk" CHECK ("products"."min_order_qty" IS NULL OR "products"."max_order_qty" IS NULL OR "products"."min_order_qty" <= "products"."max_order_qty");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_standard_price_chk" CHECK ("products"."standard_price" IS NULL OR "products"."standard_price" >= 0);