CREATE TABLE "product_kit_components" (
	"kit_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"weight" numeric(12, 4),
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_kit_components_kit_id_product_id_pk" PRIMARY KEY("kit_id","product_id"),
	CONSTRAINT "product_kit_components_qty_chk" CHECK ("product_kit_components"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "product_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"allocation" text DEFAULT 'list_price' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discount_rules" ALTER COLUMN "reward" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "discount_rules" ADD COLUMN "mix" jsonb;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "is_gift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "is_gift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_kit_components" ADD CONSTRAINT "product_kit_components_kit_id_product_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."product_kits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_kit_components" ADD CONSTRAINT "product_kit_components_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_kits" ADD CONSTRAINT "product_kits_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_kits" ADD CONSTRAINT "product_kits_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_kit_components_product_idx" ON "product_kit_components" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_kits_product_uidx" ON "product_kits" USING btree ("product_id");