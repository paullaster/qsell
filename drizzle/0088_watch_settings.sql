ALTER TABLE "vendor_settings" ADD COLUMN "watch_duplicate_window_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "watch_new_vendor_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "watch_new_vendor_amount" numeric(14, 2) DEFAULT '100000' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "hold_flagged_payments" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD CONSTRAINT "vendor_settings_watch_chk" CHECK ("watch_duplicate_window_days" BETWEEN 0 AND 365 AND "watch_new_vendor_days" BETWEEN 0 AND 3650 AND "watch_new_vendor_amount" >= 0);
