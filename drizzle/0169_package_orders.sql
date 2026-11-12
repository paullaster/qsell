CREATE TABLE "package_audiences" (
	"package_id" uuid NOT NULL,
	"customer_group_id" uuid NOT NULL,
	CONSTRAINT "package_audiences_package_id_customer_group_id_pk" PRIMARY KEY("package_id","customer_group_id")
);
--> statement-breakpoint
CREATE TABLE "package_instance_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"slot_name" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"count" integer NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"package_product_id" text NOT NULL,
	"package_name" text NOT NULL,
	"package_version" integer NOT NULL,
	"servings" integer NOT NULL,
	"serving_price" numeric(14, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"selection_key" text NOT NULL,
	"for_date" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_instances_servings_chk" CHECK ("package_instances"."servings" >= 1)
);
--> statement-breakpoint
ALTER TABLE "product_packages" ADD COLUMN "min_servings" integer;--> statement-breakpoint
ALTER TABLE "product_packages" ADD COLUMN "max_servings" integer;--> statement-breakpoint
ALTER TABLE "product_packages" ADD COLUMN "notice_minutes" integer;--> statement-breakpoint
ALTER TABLE "product_packages" ADD COLUMN "closes_days_before" integer;--> statement-breakpoint
ALTER TABLE "product_packages" ADD COLUMN "closes_at_minute" integer;--> statement-breakpoint
ALTER TABLE "product_packages" ADD COLUMN "weekdays" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "product_packages" ADD COLUMN "daily_limit" integer;--> statement-breakpoint
ALTER TABLE "product_packages" ADD COLUMN "audience" text DEFAULT 'anyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_audiences" ADD CONSTRAINT "package_audiences_package_id_product_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."product_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_audiences" ADD CONSTRAINT "package_audiences_customer_group_id_customer_groups_id_fk" FOREIGN KEY ("customer_group_id") REFERENCES "public"."customer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_instance_picks" ADD CONSTRAINT "package_instance_picks_instance_id_package_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."package_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_instances" ADD CONSTRAINT "package_instances_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "package_instance_picks_instance_idx" ON "package_instance_picks" USING btree ("instance_id","sort_order");--> statement-breakpoint
CREATE INDEX "package_instance_picks_product_idx" ON "package_instance_picks" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_instances_line_uidx" ON "package_instances" USING btree ("document_type","document_id","line_no");--> statement-breakpoint
CREATE INDEX "package_instances_day_idx" ON "package_instances" USING btree ("company_id","for_date","package_product_id");--> statement-breakpoint
ALTER TABLE "product_packages" ADD CONSTRAINT "product_packages_audience_chk" CHECK ("product_packages"."audience" IN ('anyone', 'signed_in', 'groups'));--> statement-breakpoint
ALTER TABLE "product_packages" ADD CONSTRAINT "product_packages_rules_chk" CHECK (("product_packages"."min_servings" IS NULL OR "product_packages"."min_servings" >= 1) AND ("product_packages"."max_servings" IS NULL OR "product_packages"."max_servings" >= 1) AND ("product_packages"."min_servings" IS NULL OR "product_packages"."max_servings" IS NULL OR "product_packages"."min_servings" <= "product_packages"."max_servings") AND ("product_packages"."notice_minutes" IS NULL OR "product_packages"."notice_minutes" >= 0) AND ("product_packages"."closes_days_before" IS NULL OR "product_packages"."closes_days_before" >= 0) AND ("product_packages"."closes_at_minute" IS NULL OR ("product_packages"."closes_at_minute" >= 0 AND "product_packages"."closes_at_minute" < 1440)) AND ("product_packages"."daily_limit" IS NULL OR "product_packages"."daily_limit" >= 1));