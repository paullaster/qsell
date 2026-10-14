CREATE TABLE "sales_section_template_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_section_template_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"product_id" text,
	"line_number" integer NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(14, 3) DEFAULT '1' NOT NULL,
	"price_mode" text DEFAULT 'catalog' NOT NULL,
	"unit_price" numeric(14, 4),
	"discount_percent" numeric(7, 3) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_section_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"section_title" text NOT NULL,
	"section_description" text,
	"show_lines" boolean DEFAULT false NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "from_section_template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quote_sections" ADD COLUMN "section_template_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_quote_sections" ADD COLUMN "section_template_name" text;--> statement-breakpoint
ALTER TABLE "sales_section_template_events" ADD CONSTRAINT "sales_section_template_events_template_id_sales_section_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."sales_section_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_section_template_lines" ADD CONSTRAINT "sales_section_template_lines_template_id_sales_section_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."sales_section_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_section_template_lines" ADD CONSTRAINT "sales_section_template_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_section_templates" ADD CONSTRAINT "sales_section_templates_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_section_template_events_idx" ON "sales_section_template_events" USING btree ("template_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_section_template_lines_number_uidx" ON "sales_section_template_lines" USING btree ("template_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_section_templates_company_name_uidx" ON "sales_section_templates" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "sales_section_templates_company_status_idx" ON "sales_section_templates" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "sales_quote_sections" ADD CONSTRAINT "sales_quote_sections_section_template_id_sales_section_templates_id_fk" FOREIGN KEY ("section_template_id") REFERENCES "public"."sales_section_templates"("id") ON DELETE set null ON UPDATE no action;