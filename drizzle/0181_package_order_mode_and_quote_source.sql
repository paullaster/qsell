ALTER TABLE "product_packages" ADD COLUMN "order_mode" text DEFAULT 'cart' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD COLUMN "source" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_packages" ADD CONSTRAINT "product_packages_order_mode_chk" CHECK ("product_packages"."order_mode" IN ('cart', 'quote', 'either'));--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_source_chk" CHECK ("sales_quotes"."source" IN ('staff', 'shop'));