CREATE TABLE "sales_quote_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"section_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "sales_quote_template_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"section_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text
);
--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "section_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_quote_template_lines" ADD COLUMN "section_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_quote_templates" ADD COLUMN "show_billing_address" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quote_templates" ADD COLUMN "payment_details" text;--> statement-breakpoint
ALTER TABLE "sales_quote_templates" ADD COLUMN "terms_and_conditions" text;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD COLUMN "show_billing_address" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD COLUMN "payment_details" text;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD COLUMN "terms_and_conditions" text;--> statement-breakpoint
ALTER TABLE "sales_quote_sections" ADD CONSTRAINT "sales_quote_sections_quote_id_sales_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."sales_quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quote_template_sections" ADD CONSTRAINT "sales_quote_template_sections_template_id_sales_quote_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."sales_quote_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_quote_sections_number_uidx" ON "sales_quote_sections" USING btree ("quote_id","section_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_quote_template_sections_number_uidx" ON "sales_quote_template_sections" USING btree ("template_id","section_number");--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_section_id_sales_quote_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sales_quote_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quote_template_lines" ADD CONSTRAINT "sales_quote_template_lines_section_id_sales_quote_template_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sales_quote_template_sections"("id") ON DELETE set null ON UPDATE no action;