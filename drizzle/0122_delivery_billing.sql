CREATE TABLE "delivery_billing_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'with_goods' NOT NULL,
	"service_product_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_billing_mode_chk" CHECK ("delivery_billing_settings"."mode" IN ('with_goods','separate'))
);
--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD COLUMN "invoice_kra_status" text;--> statement-breakpoint
ALTER TABLE "delivery_billing_settings" ADD CONSTRAINT "delivery_billing_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_billing_settings" ADD CONSTRAINT "delivery_billing_settings_service_product_id_products_id_fk" FOREIGN KEY ("service_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;