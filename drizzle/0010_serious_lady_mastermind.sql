ALTER TABLE "sales_quote_settings" ADD COLUMN "next_quote_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD COLUMN "quote_discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD COLUMN "share_token_hash" text;