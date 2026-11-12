CREATE TABLE "package_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"quantity" numeric(14, 3) DEFAULT 1 NOT NULL,
	"difference" numeric(14, 2) DEFAULT '0' NOT NULL,
	"own_price" numeric(14, 2),
	"is_default" boolean DEFAULT false NOT NULL,
	"weight" numeric(12, 4),
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "package_options_qty_chk" CHECK ("package_options"."quantity" > 0),
	CONSTRAINT "package_options_price_chk" CHECK ("package_options"."own_price" IS NULL OR "package_options"."own_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "package_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"name" text NOT NULL,
	"help_text" text DEFAULT '' NOT NULL,
	"min_picks" integer DEFAULT 1 NOT NULL,
	"max_picks" integer DEFAULT 1 NOT NULL,
	"allow_repeats" boolean DEFAULT false NOT NULL,
	"included" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "package_slots_picks_chk" CHECK ("package_slots"."min_picks" >= 0 AND "package_slots"."max_picks" >= 1 AND "package_slots"."min_picks" <= "package_slots"."max_picks" AND "package_slots"."max_picks" <= 50),
	CONSTRAINT "package_slots_name_chk" CHECK (length(btrim("package_slots"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "product_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"pricing_mode" text DEFAULT 'base_plus_differences' NOT NULL,
	"allocation" text DEFAULT 'list_price' NOT NULL,
	"short_stock_mode" text DEFAULT 'hide' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_packages_pricing_mode_chk" CHECK ("product_packages"."pricing_mode" IN ('base_plus_differences', 'summed')),
	CONSTRAINT "product_packages_allocation_chk" CHECK ("product_packages"."allocation" IN ('list_price', 'cost', 'explicit')),
	CONSTRAINT "product_packages_short_stock_chk" CHECK ("product_packages"."short_stock_mode" IN ('hide', 'disable', 'substitute'))
);
--> statement-breakpoint
ALTER TABLE "package_options" ADD CONSTRAINT "package_options_slot_id_package_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."package_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_options" ADD CONSTRAINT "package_options_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_slots" ADD CONSTRAINT "package_slots_package_id_product_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."product_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_packages" ADD CONSTRAINT "product_packages_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_packages" ADD CONSTRAINT "product_packages_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "package_options_slot_product_uidx" ON "package_options" USING btree ("slot_id","product_id");--> statement-breakpoint
CREATE INDEX "package_options_product_idx" ON "package_options" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "package_slots_package_idx" ON "package_slots" USING btree ("package_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "product_packages_product_uidx" ON "product_packages" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_packages_company_idx" ON "product_packages" USING btree ("company_id");