CREATE TABLE "delivery_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"max_weight_kg" numeric(12, 3),
	"max_stops" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_vehicles_limits_chk" CHECK (("delivery_vehicles"."max_weight_kg" IS NULL OR ("delivery_vehicles"."max_weight_kg" > 0 AND "delivery_vehicles"."max_weight_kg" <= 1000000)) AND ("delivery_vehicles"."max_stops" IS NULL OR ("delivery_vehicles"."max_stops" BETWEEN 1 AND 500)))
);
--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD COLUMN "vehicle_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_vehicles" ADD CONSTRAINT "delivery_vehicles_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_vehicles_company_name_uidx" ON "delivery_vehicles" USING btree ("company_id",lower("name"));--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_vehicle_id_delivery_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."delivery_vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_runs_vehicle_idx" ON "delivery_runs" USING btree ("vehicle_id") WHERE "delivery_runs"."vehicle_id" IS NOT NULL;