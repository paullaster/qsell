CREATE TABLE "etims_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"config_source" text NOT NULL,
	"kra_item_code" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"name" text NOT NULL,
	"org_country_code" text DEFAULT 'KE' NOT NULL,
	"unit_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"item_type_code" text NOT NULL,
	"tax_code" text NOT NULL,
	"qty_unit_code" text NOT NULL,
	"pkg_unit_code" text NOT NULL,
	"item_class_code" text NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "etims_items" ADD CONSTRAINT "etims_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "etims_items" ADD CONSTRAINT "etims_items_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "etims_items_product_branch_uidx" ON "etims_items" USING btree ("product_id","branch_id") WHERE "etims_items"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "etims_items_branch_code_uidx" ON "etims_items" USING btree ("branch_id","kra_item_code") WHERE "etims_items"."kra_item_code" is not null and "etims_items"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "etims_items_branch_idx" ON "etims_items" USING btree ("branch_id");