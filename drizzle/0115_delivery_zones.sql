CREATE TABLE "delivery_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"method" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"lead_time_minutes" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_methods_method_chk" CHECK ("delivery_methods"."method" IN ('own_fleet','courier','pickup','scheduled_visit')),
	CONSTRAINT "delivery_methods_lead_chk" CHECK ("delivery_methods"."lead_time_minutes" >= 0 AND "delivery_methods"."lead_time_minutes" <= 43200)
);
--> statement-breakpoint
CREATE TABLE "delivery_zone_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"county" text,
	"town" text,
	"area" text,
	"county_key" text DEFAULT '' NOT NULL,
	"town_key" text DEFAULT '' NOT NULL,
	"area_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_zone_areas_words_chk" CHECK ("delivery_zone_areas"."county_key" <> '' OR "delivery_zone_areas"."town_key" <> '' OR "delivery_zone_areas"."area_key" <> '')
);
--> statement-breakpoint
CREATE TABLE "delivery_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"centre_latitude" double precision,
	"centre_longitude" double precision,
	"radius_km" numeric(8, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_zones_circle_chk" CHECK (("delivery_zones"."centre_latitude" IS NULL) = ("delivery_zones"."centre_longitude" IS NULL) AND ("delivery_zones"."centre_latitude" IS NULL) = ("delivery_zones"."radius_km" IS NULL) AND ("delivery_zones"."centre_latitude" IS NULL OR ("delivery_zones"."centre_latitude" BETWEEN -90 AND 90 AND "delivery_zones"."centre_longitude" BETWEEN -180 AND 180 AND "delivery_zones"."radius_km" > 0 AND "delivery_zones"."radius_km" <= 2000)))
);
--> statement-breakpoint
ALTER TABLE "delivery_methods" ADD CONSTRAINT "delivery_methods_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_methods" ADD CONSTRAINT "delivery_methods_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_zone_areas" ADD CONSTRAINT "delivery_zone_areas_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_zone_areas" ADD CONSTRAINT "delivery_zone_areas_zone_id_delivery_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."delivery_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_methods_branch_method_uidx" ON "delivery_methods" USING btree ("branch_id","method");--> statement-breakpoint
CREATE INDEX "delivery_methods_company_idx" ON "delivery_methods" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_zone_areas_keys_uidx" ON "delivery_zone_areas" USING btree ("company_id","county_key","town_key","area_key");--> statement-breakpoint
CREATE INDEX "delivery_zone_areas_zone_idx" ON "delivery_zone_areas" USING btree ("zone_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_zones_company_code_uidx" ON "delivery_zones" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "delivery_zones_company_active_idx" ON "delivery_zones" USING btree ("company_id","is_active");--> statement-breakpoint
-- Delivery set-up is for administrators; anyone who can read other settings gets nothing new by this.
INSERT INTO "permissions" ("key", "resource", "action", "category", "description") VALUES
  ('deliveries:read', 'deliveries', 'read', 'Orders & Sales', 'See delivery zones, areas and the delivery methods each branch offers'),
  ('deliveries:manage', 'deliveries', 'manage', 'Orders & Sales', 'Create and change delivery zones and areas, and choose the delivery methods each branch offers')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT r."id", p."id", 'allow'
FROM "roles" r
JOIN "permissions" p ON p."key" IN ('deliveries:read', 'deliveries:manage')
WHERE r."key" = 'admin'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
