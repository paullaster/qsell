CREATE TABLE "packaging_fits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"packaging_product_id" text NOT NULL,
	"capacity" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packaging_fits_capacity_chk" CHECK ("packaging_fits"."capacity" > 0),
	CONSTRAINT "packaging_fits_distinct_products_chk" CHECK ("packaging_fits"."product_id" <> "packaging_fits"."packaging_product_id")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_checkout_packaging" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "packaging_fits" ADD CONSTRAINT "packaging_fits_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packaging_fits" ADD CONSTRAINT "packaging_fits_packaging_product_id_products_id_fk" FOREIGN KEY ("packaging_product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "packaging_fits_pair_uidx" ON "packaging_fits" USING btree ("product_id","packaging_product_id");--> statement-breakpoint
CREATE INDEX "packaging_fits_package_idx" ON "packaging_fits" USING btree ("packaging_product_id","product_id");