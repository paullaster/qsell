CREATE TABLE "kra_signing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"document_key" text NOT NULL,
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"document_ref" text,
	"module" text NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"scope" text,
	"mode" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transmission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_profiles" ALTER COLUMN "transmit_invoices_to_kra" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "transmit_invoices_to_kra" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "transmit_invoices_to_kra" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "branch_kra_configs" ADD COLUMN "allow_etims_signing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_kra_configs" ADD COLUMN "allow_tims_signing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "branch_kra_configs" ADD COLUMN "module_signing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_kra_configs" ADD COLUMN "allow_etims_signing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_kra_configs" ADD COLUMN "allow_tims_signing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_kra_configs" ADD COLUMN "module_signing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sales_module" text DEFAULT 'ecommerce' NOT NULL;--> statement-breakpoint
-- Existing orders pre-date modules: sales on account are credit sales, quote conversions are
-- sales orders, everything else came through the store.
UPDATE "orders" SET "sales_module" = 'credit_sale' WHERE "payment_method" = 'on_account';--> statement-breakpoint
UPDATE "orders" SET "sales_module" = 'sales_order' WHERE "id" LIKE 'ord_quote_%' AND "payment_method" <> 'on_account';--> statement-breakpoint
ALTER TABLE "kra_signing_events" ADD CONSTRAINT "kra_signing_events_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kra_signing_events" ADD CONSTRAINT "kra_signing_events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kra_signing_events" ADD CONSTRAINT "kra_signing_events_transmission_id_kra_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."kra_transmissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kra_signing_events_document_idx" ON "kra_signing_events" USING btree ("document_key","created_at");--> statement-breakpoint
CREATE INDEX "kra_signing_events_created_idx" ON "kra_signing_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "kra_signing_events_outcome_idx" ON "kra_signing_events" USING btree ("outcome");