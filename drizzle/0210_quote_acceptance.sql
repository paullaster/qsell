ALTER TABLE "sales_quote_settings" ADD COLUMN "on_acceptance" text DEFAULT 'sales_order' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quote_settings" ADD COLUMN "notify_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quote_settings" ADD COLUMN "notify_sms" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quote_settings" ADD COLUMN "notify_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quote_settings" ADD CONSTRAINT "sales_quote_settings_acceptance_chk" CHECK ("sales_quote_settings"."on_acceptance" IN ('notify', 'sales_order', 'sales_invoice', 'credit_sale'));