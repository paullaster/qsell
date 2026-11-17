CREATE TABLE "selling_document_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_locations" ALTER COLUMN "sells_channels" SET DEFAULT ARRAY['ecommerce','sales_order','credit_sale','pos_cash_sale','sales_invoice']::text[];--> statement-breakpoint
ALTER TABLE "selling_document_settings" ADD CONSTRAINT "selling_document_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "selling_document_settings_company_type_uidx" ON "selling_document_settings" USING btree ("company_id","doc_type");--> statement-breakpoint
-- A stock location that sells to sales orders also sells to the new sales invoices, so a sales invoice finds stock where a sales order does.
UPDATE "stock_locations" SET "sells_channels" = array_append("sells_channels", 'sales_invoice') WHERE 'sales_order' = ANY("sells_channels") AND NOT ('sales_invoice' = ANY("sells_channels"));
