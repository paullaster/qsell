CREATE TABLE "sales_reps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"home_branch_id" uuid,
	"modes" text[] DEFAULT ARRAY['van_sell','pre_sell']::text[] NOT NULL,
	"max_discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"max_credit_per_day" numeric(14, 2) DEFAULT '0' NOT NULL,
	"may_override_price" boolean DEFAULT false NOT NULL,
	"may_sell_on_credit" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_reps_status_chk" CHECK ("sales_reps"."status" IN ('active','paused','ended')),
	CONSTRAINT "sales_reps_reason_chk" CHECK ("sales_reps"."status" = 'active' OR ("sales_reps"."status_reason" IS NOT NULL AND length(btrim("sales_reps"."status_reason")) > 0)),
	CONSTRAINT "sales_reps_modes_chk" CHECK (cardinality("sales_reps"."modes") > 0 AND "sales_reps"."modes" <@ ARRAY['van_sell','pre_sell']::text[]),
	CONSTRAINT "sales_reps_discount_chk" CHECK ("sales_reps"."max_discount_percent" BETWEEN 0 AND 100),
	CONSTRAINT "sales_reps_credit_chk" CHECK ("sales_reps"."max_credit_per_day" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"location_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"max_cash" numeric(14, 2),
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vans_status_chk" CHECK ("vans"."status" IN ('active','stopped')),
	CONSTRAINT "vans_stopped_reason_chk" CHECK ("vans"."status" = 'active' OR ("vans"."status_reason" IS NOT NULL AND length(btrim("vans"."status_reason")) > 0)),
	CONSTRAINT "vans_max_cash_chk" CHECK ("vans"."max_cash" IS NULL OR "vans"."max_cash" > 0)
);
--> statement-breakpoint
ALTER TABLE "sales_reps" ADD CONSTRAINT "sales_reps_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_reps" ADD CONSTRAINT "sales_reps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_reps" ADD CONSTRAINT "sales_reps_home_branch_id_branches_id_fk" FOREIGN KEY ("home_branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vans" ADD CONSTRAINT "vans_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vans" ADD CONSTRAINT "vans_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vans" ADD CONSTRAINT "vans_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vans" ADD CONSTRAINT "vans_register_id_registers_id_fk" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vans" ADD CONSTRAINT "vans_vehicle_id_delivery_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."delivery_vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_reps_company_user_uidx" ON "sales_reps" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "sales_reps_company_status_idx" ON "sales_reps" USING btree ("company_id","status","name");--> statement-breakpoint
CREATE UNIQUE INDEX "vans_company_name_uidx" ON "vans" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "vans_location_uidx" ON "vans" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vans_register_uidx" ON "vans" USING btree ("register_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vans_active_vehicle_uidx" ON "vans" USING btree ("vehicle_id") WHERE "vans"."vehicle_id" IS NOT NULL AND "vans"."status" = 'active';--> statement-breakpoint
CREATE INDEX "vans_company_status_idx" ON "vans" USING btree ("company_id","status","name");