CREATE TABLE "price_floor_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_ref" text DEFAULT '' NOT NULL,
	"markup_percent" numeric(8, 3) NOT NULL,
	"enforcement" text DEFAULT 'approval' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_floor_rules_markup_chk" CHECK ("price_floor_rules"."markup_percent" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_override_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"max_percent" numeric(6, 3) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_override_limits_pct_chk" CHECK ("price_override_limits"."max_percent" >= 0 and "price_override_limits"."max_percent" <= 100)
);
--> statement-breakpoint
CREATE TABLE "product_group_members" (
	"group_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_group_members_group_id_product_id_pk" PRIMARY KEY("group_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "product_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "price_floor_rules" ADD CONSTRAINT "price_floor_rules_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_override_limits" ADD CONSTRAINT "price_override_limits_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_group_members" ADD CONSTRAINT "product_group_members_group_id_product_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."product_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_group_members" ADD CONSTRAINT "product_group_members_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_groups" ADD CONSTRAINT "product_groups_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_floor_rules_scope_uidx" ON "price_floor_rules" USING btree ("company_id","scope_type","scope_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "price_override_limits_role_uidx" ON "price_override_limits" USING btree ("company_id","role_key");--> statement-breakpoint
CREATE INDEX "product_group_members_product_idx" ON "product_group_members" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_groups_company_code_uidx" ON "product_groups" USING btree ("company_id","code");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_parent_idx" ON "categories" USING btree ("parent_id");