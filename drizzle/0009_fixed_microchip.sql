CREATE TABLE "sales_quote_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"product_id" text,
	"line_number" integer NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"tax_rate" numeric(7, 3) DEFAULT '0' NOT NULL,
	"is_tax_inclusive" boolean DEFAULT true NOT NULL,
	"discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"net_amount" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"line_amount" numeric(14, 2) NOT NULL,
	"cost_amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_quote_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"minimum_gross_margin_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"customer_id" uuid,
	"quote_number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"customer_phone" text,
	"billing_address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivery_address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"shipping_fee" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"gross_profit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"gross_margin_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"minimum_margin_percent" numeric(7, 3) DEFAULT '0' NOT NULL,
	"approval_status" text DEFAULT 'not_required' NOT NULL,
	"payment_method" text DEFAULT 'mpesa_daraja' NOT NULL,
	"valid_until" timestamp with time zone,
	"customer_reference" text,
	"public_notes" text,
	"internal_notes" text,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"converted_order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_quote_events" ADD CONSTRAINT "sales_quote_events_quote_id_sales_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."sales_quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_quote_id_sales_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."sales_quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quote_settings" ADD CONSTRAINT "sales_quote_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD CONSTRAINT "sales_quotes_converted_order_id_orders_id_fk" FOREIGN KEY ("converted_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_quote_events_quote_idx" ON "sales_quote_events" USING btree ("quote_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_quote_lines_number_uidx" ON "sales_quote_lines" USING btree ("quote_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_quotes_company_number_uidx" ON "sales_quotes" USING btree ("company_id","quote_number");--> statement-breakpoint
CREATE INDEX "sales_quotes_company_status_idx" ON "sales_quotes" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "sales_quotes_customer_idx" ON "sales_quotes" USING btree ("customer_id","created_at");