CREATE TABLE "delivery_run_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"left_reason" text,
	CONSTRAINT "delivery_run_stops_sequence_chk" CHECK ("delivery_run_stops"."sequence" >= 1),
	CONSTRAINT "delivery_run_stops_left_chk" CHECK (("delivery_run_stops"."left_at" IS NULL) = ("delivery_run_stops"."left_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "delivery_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"run_date" date NOT NULL,
	"rider_name" text NOT NULL,
	"vehicle" text,
	"notes" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_runs_status_chk" CHECK ("delivery_runs"."status" IN ('planned','started','completed','cancelled')),
	CONSTRAINT "delivery_runs_closed_chk" CHECK (("delivery_runs"."status" IN ('completed','cancelled')) = ("delivery_runs"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "delivery_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"adapter" text DEFAULT 'manual' NOT NULL,
	"courier_name" text NOT NULL,
	"tracking_number" text,
	"status" text DEFAULT 'in_transit' NOT NULL,
	"last_note" text,
	"last_update_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_shipments_status_chk" CHECK ("delivery_shipments"."status" IN ('booked','in_transit','delivered','exception'))
);
--> statement-breakpoint
ALTER TABLE "delivery_run_stops" ADD CONSTRAINT "delivery_run_stops_run_id_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."delivery_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_run_stops" ADD CONSTRAINT "delivery_run_stops_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD CONSTRAINT "delivery_shipments_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD CONSTRAINT "delivery_shipments_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_run_stops_live_uidx" ON "delivery_run_stops" USING btree ("delivery_id") WHERE "delivery_run_stops"."left_at" IS NULL;--> statement-breakpoint
CREATE INDEX "delivery_run_stops_run_idx" ON "delivery_run_stops" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_runs_company_number_uidx" ON "delivery_runs" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "delivery_runs_day_idx" ON "delivery_runs" USING btree ("company_id","run_date","status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_shipments_delivery_uidx" ON "delivery_shipments" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "delivery_shipments_company_idx" ON "delivery_shipments" USING btree ("company_id","status");