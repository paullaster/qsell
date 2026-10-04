CREATE TABLE "media_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"resource_type" text DEFAULT 'image' NOT NULL,
	"purpose" text DEFAULT 'product' NOT NULL,
	"storage_key" text,
	"source_url" text,
	"mime" text DEFAULT '' NOT NULL,
	"bytes" integer,
	"width" integer,
	"height" integer,
	"sha256" text,
	"original_name" text DEFAULT '' NOT NULL,
	"alt_text" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_by" uuid,
	"created_by_email" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_assets_location_chk" CHECK (("media_assets"."provider" = 'external' and "media_assets"."source_url" is not null) or ("media_assets"."provider" <> 'external' and "media_assets"."storage_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "product_media" (
	"product_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"alt_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_media_product_id_asset_id_pk" PRIMARY KEY("product_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_storage_uidx" ON "media_assets" USING btree ("provider","storage_key") WHERE "media_assets"."storage_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_external_url_uidx" ON "media_assets" USING btree ("source_url") WHERE "media_assets"."provider" = 'external' and "media_assets"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "media_assets_sha_idx" ON "media_assets" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "media_assets_library_idx" ON "media_assets" USING btree ("status","purpose","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_media_primary_uidx" ON "product_media" USING btree ("product_id") WHERE "product_media"."is_primary";--> statement-breakpoint
CREATE INDEX "product_media_asset_idx" ON "product_media" USING btree ("asset_id");--> statement-breakpoint
-- Backfill: every existing product image URL becomes an 'external' asset (de-duplicated by URL,
-- so products sharing a link share an asset) and a product_media row. The primary image keeps
-- position 0; additional images follow in their stored order. products.image_url and
-- additional_images stay as the denormalised copy the storefront and CSV already read.
INSERT INTO "media_assets" ("id", "provider", "visibility", "resource_type", "purpose", "source_url", "status", "created_by_email")
SELECT 'media_' || gen_random_uuid()::text, 'external', 'public', 'image', 'product', u.url, 'ready', 'backfill'
FROM (
	SELECT btrim("image_url") AS url FROM "products" WHERE btrim("image_url") <> ''
	UNION
	SELECT btrim(e.value) FROM "products" p, LATERAL jsonb_array_elements_text(p."additional_images") AS e(value) WHERE btrim(e.value) <> ''
) u
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "product_media" ("product_id", "asset_id", "position", "is_primary")
SELECT p."id", a."id", 0, true
FROM "products" p
JOIN "media_assets" a ON a."provider" = 'external' AND a."deleted_at" IS NULL AND a."source_url" = btrim(p."image_url")
WHERE btrim(p."image_url") <> ''
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "product_media" ("product_id", "asset_id", "position", "is_primary")
SELECT p."id", a."id", e.ord::int, false
FROM "products" p
CROSS JOIN LATERAL jsonb_array_elements_text(p."additional_images") WITH ORDINALITY AS e(value, ord)
JOIN "media_assets" a ON a."provider" = 'external' AND a."deleted_at" IS NULL AND a."source_url" = btrim(e.value)
ON CONFLICT DO NOTHING;
