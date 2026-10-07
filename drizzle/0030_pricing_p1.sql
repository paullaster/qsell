CREATE TABLE "customer_group_members" (
	"group_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_group_members_group_id_customer_id_pk" PRIMARY KEY("group_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "customer_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_list_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_list_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"price" numeric(14, 4) NOT NULL,
	"tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"floor_price" numeric(14, 4),
	"locked_until" timestamp with time zone,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"reason_code" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text DEFAULT 'list' NOT NULL,
	"currency" text NOT NULL,
	"tax_inclusive" boolean DEFAULT true NOT NULL,
	"quantity_mode" text DEFAULT 'all_units' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"scopes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_status" text DEFAULT 'none' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_specificity_weights" (
	"company_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"weight" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_specificity_weights_company_id_dimension_pk" PRIMARY KEY("company_id","dimension")
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "price_trace" jsonb;--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "price_trace" jsonb;--> statement-breakpoint
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_group_id_customer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."customer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_group_members" ADD CONSTRAINT "customer_group_members_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_lines" ADD CONSTRAINT "price_list_lines_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_lines" ADD CONSTRAINT "price_list_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_specificity_weights" ADD CONSTRAINT "price_specificity_weights_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_group_members_customer_idx" ON "customer_group_members" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_groups_company_code_uidx" ON "customer_groups" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "price_list_lines_product_idx" ON "price_list_lines" USING btree ("product_id","price_list_id","valid_from");--> statement-breakpoint
CREATE INDEX "price_list_lines_list_product_idx" ON "price_list_lines" USING btree ("price_list_id","product_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_lines_open_uidx" ON "price_list_lines" USING btree ("price_list_id","product_id") WHERE "price_list_lines"."valid_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_company_code_uidx" ON "price_lists" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "price_lists_company_status_idx" ON "price_lists" USING btree ("company_id","status");