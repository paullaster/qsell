CREATE TABLE "charge_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"method" text NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"scopes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"distance_basis" text DEFAULT 'one_way' NOT NULL,
	"max_range_km" numeric(8, 2),
	"per_minute" numeric(12, 4) DEFAULT '0' NOT NULL,
	"included_kg" numeric(10, 3),
	"per_extra_kg" numeric(12, 4) DEFAULT '0' NOT NULL,
	"max_weight_kg" numeric(10, 3),
	"min_charge" numeric(14, 4),
	"max_charge" numeric(14, 4),
	"round_to" numeric(12, 4) DEFAULT '0' NOT NULL,
	"round_mode" text DEFAULT 'nearest' NOT NULL,
	"bands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"surcharges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"retired_at" timestamp with time zone,
	"retired_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "charge_policies_status_chk" CHECK ("charge_policies"."status" IN ('draft','in_force','retired')),
	CONSTRAINT "charge_policies_method_chk" CHECK ("charge_policies"."method" IN ('zone_rate','flat','distance')),
	CONSTRAINT "charge_policies_basis_chk" CHECK ("charge_policies"."distance_basis" IN ('one_way','longer_leg','round_trip')),
	CONSTRAINT "charge_policies_round_chk" CHECK ("charge_policies"."round_mode" IN ('nearest','up') AND "charge_policies"."round_to" >= 0),
	CONSTRAINT "charge_policies_currency_chk" CHECK ("charge_policies"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "charge_policies_dates_chk" CHECK ("charge_policies"."valid_to" IS NULL OR "charge_policies"."valid_to" > "charge_policies"."valid_from"),
	CONSTRAINT "charge_policies_charges_chk" CHECK (("charge_policies"."min_charge" IS NULL OR "charge_policies"."min_charge" >= 0) AND ("charge_policies"."max_charge" IS NULL OR "charge_policies"."max_charge" >= 0) AND ("charge_policies"."min_charge" IS NULL OR "charge_policies"."max_charge" IS NULL OR "charge_policies"."min_charge" <= "charge_policies"."max_charge") AND "charge_policies"."per_minute" >= 0 AND "charge_policies"."per_extra_kg" >= 0)
);
--> statement-breakpoint
CREATE TABLE "charge_policy_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"zone_id" uuid,
	"from_kg" numeric(10, 3) DEFAULT '0' NOT NULL,
	"to_kg" numeric(10, 3),
	"fee" numeric(14, 4) NOT NULL,
	"per_extra_kg" numeric(12, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "charge_policy_rates_chk" CHECK ("charge_policy_rates"."from_kg" >= 0 AND ("charge_policy_rates"."to_kg" IS NULL OR "charge_policy_rates"."to_kg" > "charge_policy_rates"."from_kg") AND "charge_policy_rates"."fee" >= 0 AND "charge_policy_rates"."per_extra_kg" >= 0)
);
--> statement-breakpoint
ALTER TABLE "charge_policies" ADD CONSTRAINT "charge_policies_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_policy_rates" ADD CONSTRAINT "charge_policy_rates_policy_id_charge_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."charge_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charge_policy_rates" ADD CONSTRAINT "charge_policy_rates_zone_id_delivery_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."delivery_zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charge_policies_company_code_version_uidx" ON "charge_policies" USING btree ("company_id","code","version");--> statement-breakpoint
CREATE UNIQUE INDEX "charge_policies_one_draft_uidx" ON "charge_policies" USING btree ("company_id","code") WHERE "charge_policies"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "charge_policies_one_in_force_uidx" ON "charge_policies" USING btree ("company_id","code") WHERE "charge_policies"."status" = 'in_force';--> statement-breakpoint
CREATE INDEX "charge_policies_company_status_idx" ON "charge_policies" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "charge_policy_rates_band_uidx" ON "charge_policy_rates" USING btree ("policy_id",coalesce("zone_id", '00000000-0000-0000-0000-000000000000'::uuid),"from_kg");--> statement-breakpoint
CREATE INDEX "charge_policy_rates_zone_idx" ON "charge_policy_rates" USING btree ("zone_id");--> statement-breakpoint
-- Charge policies decide what customers pay, so only administrators may write them.
INSERT INTO "permissions" ("key", "resource", "action", "category", "description") VALUES
  ('delivery_rates:manage', 'delivery_rates', 'manage', 'Orders & Sales', 'Write, change, put in force and retire the policies that work out delivery charges')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT r."id", p."id", 'allow'
FROM "roles" r
JOIN "permissions" p ON p."key" = 'delivery_rates:manage'
WHERE r."key" = 'admin'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
