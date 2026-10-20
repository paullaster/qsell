CREATE TABLE "product_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"unit_id" uuid NOT NULL,
	"qty_per_base" numeric(24, 10) NOT NULL,
	"weight_kg" numeric(12, 4),
	"is_sales_default" boolean DEFAULT false NOT NULL,
	"is_purchase_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_units_qty_chk" CHECK ("product_units"."qty_per_base" > 0),
	CONSTRAINT "product_units_weight_chk" CHECK ("product_units"."weight_kg" IS NULL OR "product_units"."weight_kg" >= 0)
);
--> statement-breakpoint
CREATE TABLE "units_of_measure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"symbol" text,
	"kind" text NOT NULL,
	"base_unit_id" uuid,
	"factor_to_base" numeric(24, 10) DEFAULT '1' NOT NULL,
	"decimals" smallint DEFAULT 0 NOT NULL,
	"international_code" text,
	"etims_code" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_of_measure_code_chk" CHECK ("units_of_measure"."code" ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'),
	CONSTRAINT "units_of_measure_name_chk" CHECK (char_length(btrim("units_of_measure"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "units_of_measure_kind_chk" CHECK ("units_of_measure"."kind" IN ('count','mass','volume','length','area','time','packaging')),
	CONSTRAINT "units_of_measure_decimals_chk" CHECK ("units_of_measure"."decimals" BETWEEN 0 AND 6),
	CONSTRAINT "units_of_measure_factor_chk" CHECK ("units_of_measure"."factor_to_base" > 0),
	CONSTRAINT "units_of_measure_base_chk" CHECK (("units_of_measure"."base_unit_id" IS NULL AND "units_of_measure"."factor_to_base" = 1) OR ("units_of_measure"."base_unit_id" IS NOT NULL AND "units_of_measure"."base_unit_id" <> "units_of_measure"."id" AND "units_of_measure"."kind" <> 'packaging')),
	CONSTRAINT "units_of_measure_default_active_chk" CHECK (NOT "units_of_measure"."is_default" OR "units_of_measure"."is_active"),
	CONSTRAINT "units_of_measure_version_chk" CHECK ("units_of_measure"."version" >= 1)
);
--> statement-breakpoint
-- The standard units every business needs, so that a product always has a base unit. Bases are written
-- first; the units that are multiples of one point at it by code.
INSERT INTO "units_of_measure" ("code", "name", "symbol", "kind", "decimals", "international_code", "etims_code", "is_default")
SELECT s."code", s."name", s."symbol", s."kind", s."decimals", s."international_code", s."etims_code", s."is_default"
FROM (VALUES
  ('PCS', 'Piece', 'pc', 'count', NULL, 1, 0, 'C62', 'U', true),
  ('DOZ', 'Dozen', 'doz', 'count', 'PCS', 12, 0, 'DZN', 'DZ', false),
  ('PAIR', 'Pair', 'pr', 'count', 'PCS', 2, 0, 'PR', '4B', false),
  ('KG', 'Kilogram', 'kg', 'mass', NULL, 1, 3, 'KGM', 'KG', false),
  ('G', 'Gram', 'g', 'mass', 'KG', 0.001, 0, 'GRM', 'GRM', false),
  ('MG', 'Milligram', 'mg', 'mass', 'KG', 0.000001, 0, 'MGM', NULL, false),
  ('T', 'Tonne', 't', 'mass', 'KG', 1000, 3, 'TNE', 'TNE', false),
  ('LB', 'Pound', 'lb', 'mass', 'KG', 0.45359237, 2, 'LBR', NULL, false),
  ('L', 'Litre', 'L', 'volume', NULL, 1, 3, 'LTR', 'L', false),
  ('ML', 'Millilitre', 'mL', 'volume', 'L', 0.001, 0, 'MLT', NULL, false),
  ('GAL', 'Gallon (US)', 'gal', 'volume', 'L', 3.785411784, 2, 'GLL', 'GL', false),
  ('M', 'Metre', 'm', 'length', NULL, 1, 2, 'MTR', 'M', false),
  ('CM', 'Centimetre', 'cm', 'length', 'M', 0.01, 1, 'CMT', NULL, false),
  ('MM', 'Millimetre', 'mm', 'length', 'M', 0.001, 0, 'MMT', NULL, false),
  ('KM', 'Kilometre', 'km', 'length', 'M', 1000, 3, 'KMT', 'KM', false),
  ('IN', 'Inch', 'in', 'length', 'M', 0.0254, 1, 'INH', NULL, false),
  ('FT', 'Foot', 'ft', 'length', 'M', 0.3048, 2, 'FOT', NULL, false),
  ('M2', 'Square metre', 'm²', 'area', NULL, 1, 2, 'MTK', NULL, false),
  ('HR', 'Hour', 'h', 'time', NULL, 1, 2, 'HUR', NULL, false),
  ('DAY', 'Day', 'd', 'time', 'HR', 24, 2, 'DAY', NULL, false),
  ('WK', 'Week', 'wk', 'time', 'HR', 168, 2, 'WEE', NULL, false),
  ('BOX', 'Box', NULL, 'packaging', NULL, 1, 0, 'BX', 'BX', false),
  ('CTN', 'Carton', NULL, 'packaging', NULL, 1, 0, 'CT', 'CT', false),
  ('CRATE', 'Crate', NULL, 'packaging', NULL, 1, 0, 'CR', NULL, false),
  ('BAG', 'Bag', NULL, 'packaging', NULL, 1, 0, 'BG', 'BG', false),
  ('PACK', 'Pack', NULL, 'packaging', NULL, 1, 0, 'PK', 'PA', false),
  ('BTL', 'Bottle', NULL, 'packaging', NULL, 1, 0, 'BO', NULL, false),
  ('CAN', 'Can', NULL, 'packaging', NULL, 1, 0, 'CA', 'CA', false),
  ('ROLL', 'Roll', NULL, 'packaging', NULL, 1, 0, 'RO', NULL, false)
) AS s("code", "name", "symbol", "kind", "base_code", "factor", "decimals", "international_code", "etims_code", "is_default")
WHERE s."base_code" IS NULL;--> statement-breakpoint
INSERT INTO "units_of_measure" ("code", "name", "symbol", "kind", "base_unit_id", "factor_to_base", "decimals", "international_code", "etims_code", "is_default")
SELECT s."code", s."name", s."symbol", s."kind", b."id", s."factor", s."decimals", s."international_code", s."etims_code", s."is_default"
FROM (VALUES
  ('PCS', 'Piece', 'pc', 'count', NULL, 1, 0, 'C62', 'U', true),
  ('DOZ', 'Dozen', 'doz', 'count', 'PCS', 12, 0, 'DZN', 'DZ', false),
  ('PAIR', 'Pair', 'pr', 'count', 'PCS', 2, 0, 'PR', '4B', false),
  ('KG', 'Kilogram', 'kg', 'mass', NULL, 1, 3, 'KGM', 'KG', false),
  ('G', 'Gram', 'g', 'mass', 'KG', 0.001, 0, 'GRM', 'GRM', false),
  ('MG', 'Milligram', 'mg', 'mass', 'KG', 0.000001, 0, 'MGM', NULL, false),
  ('T', 'Tonne', 't', 'mass', 'KG', 1000, 3, 'TNE', 'TNE', false),
  ('LB', 'Pound', 'lb', 'mass', 'KG', 0.45359237, 2, 'LBR', NULL, false),
  ('L', 'Litre', 'L', 'volume', NULL, 1, 3, 'LTR', 'L', false),
  ('ML', 'Millilitre', 'mL', 'volume', 'L', 0.001, 0, 'MLT', NULL, false),
  ('GAL', 'Gallon (US)', 'gal', 'volume', 'L', 3.785411784, 2, 'GLL', 'GL', false),
  ('M', 'Metre', 'm', 'length', NULL, 1, 2, 'MTR', 'M', false),
  ('CM', 'Centimetre', 'cm', 'length', 'M', 0.01, 1, 'CMT', NULL, false),
  ('MM', 'Millimetre', 'mm', 'length', 'M', 0.001, 0, 'MMT', NULL, false),
  ('KM', 'Kilometre', 'km', 'length', 'M', 1000, 3, 'KMT', 'KM', false),
  ('IN', 'Inch', 'in', 'length', 'M', 0.0254, 1, 'INH', NULL, false),
  ('FT', 'Foot', 'ft', 'length', 'M', 0.3048, 2, 'FOT', NULL, false),
  ('M2', 'Square metre', 'm²', 'area', NULL, 1, 2, 'MTK', NULL, false),
  ('HR', 'Hour', 'h', 'time', NULL, 1, 2, 'HUR', NULL, false),
  ('DAY', 'Day', 'd', 'time', 'HR', 24, 2, 'DAY', NULL, false),
  ('WK', 'Week', 'wk', 'time', 'HR', 168, 2, 'WEE', NULL, false),
  ('BOX', 'Box', NULL, 'packaging', NULL, 1, 0, 'BX', 'BX', false),
  ('CTN', 'Carton', NULL, 'packaging', NULL, 1, 0, 'CT', 'CT', false),
  ('CRATE', 'Crate', NULL, 'packaging', NULL, 1, 0, 'CR', NULL, false),
  ('BAG', 'Bag', NULL, 'packaging', NULL, 1, 0, 'BG', 'BG', false),
  ('PACK', 'Pack', NULL, 'packaging', NULL, 1, 0, 'PK', 'PA', false),
  ('BTL', 'Bottle', NULL, 'packaging', NULL, 1, 0, 'BO', NULL, false),
  ('CAN', 'Can', NULL, 'packaging', NULL, 1, 0, 'CA', 'CA', false),
  ('ROLL', 'Roll', NULL, 'packaging', NULL, 1, 0, 'RO', NULL, false)
) AS s("code", "name", "symbol", "kind", "base_code", "factor", "decimals", "international_code", "etims_code", "is_default")
JOIN "units_of_measure" b ON b."code" = s."base_code"
WHERE s."base_code" IS NOT NULL;--> statement-breakpoint
-- The unit a product takes when it is written without one (older code paths, imports, seeds).
CREATE FUNCTION "default_unit_id"() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT "id" FROM "units_of_measure" WHERE "is_default" LIMIT 1 $$;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "base_unit_id" uuid DEFAULT default_unit_id() NOT NULL;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_unit_id_units_of_measure_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_base_unit_id_units_of_measure_id_fk" FOREIGN KEY ("base_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_units_product_unit_uidx" ON "product_units" USING btree ("product_id","unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_units_sales_default_uidx" ON "product_units" USING btree ("product_id") WHERE "product_units"."is_sales_default";--> statement-breakpoint
CREATE UNIQUE INDEX "product_units_purchase_default_uidx" ON "product_units" USING btree ("product_id") WHERE "product_units"."is_purchase_default";--> statement-breakpoint
CREATE INDEX "product_units_unit_idx" ON "product_units" USING btree ("unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "units_of_measure_code_uidx" ON "units_of_measure" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "units_of_measure_name_uidx" ON "units_of_measure" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "units_of_measure_default_uidx" ON "units_of_measure" USING btree ("is_default") WHERE "units_of_measure"."is_default";--> statement-breakpoint
CREATE INDEX "units_of_measure_base_idx" ON "units_of_measure" USING btree ("base_unit_id");--> statement-breakpoint
CREATE INDEX "units_of_measure_kind_idx" ON "units_of_measure" USING btree ("kind","code");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_base_unit_id_units_of_measure_id_fk" FOREIGN KEY ("base_unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_base_unit_idx" ON "products" USING btree ("base_unit_id");