ALTER TABLE "supplier_invoices" ADD COLUMN "etims_invoice_no" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "etims_verification_url" text;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "require_etims_for_tax" boolean DEFAULT false NOT NULL;