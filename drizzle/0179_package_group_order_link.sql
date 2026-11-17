ALTER TABLE "package_group_orders" ADD COLUMN "token_sealed" jsonb;--> statement-breakpoint
ALTER TABLE "package_group_orders" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "package_group_orders" ADD COLUMN "order_number" text;--> statement-breakpoint
ALTER TABLE "package_group_orders" ADD COLUMN "ordered_at" timestamp with time zone;