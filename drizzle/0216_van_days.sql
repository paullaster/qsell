CREATE TABLE "van_day_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "van_day_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"action" text NOT NULL,
	"actor_type" text DEFAULT 'user' NOT NULL,
	"actor_id" text,
	"from_status" text,
	"to_status" text,
	"reason" text,
	"device_time" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "van_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"route_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"rep_id" uuid NOT NULL,
	"van_id" uuid,
	"day_date" date NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"status_reason" text,
	"shift_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "van_days_status_chk" CHECK ("van_days"."status" IN ('planned','loading','out','returning','reconciling','closed','cancelled')),
	CONSTRAINT "van_days_mode_chk" CHECK ("van_days"."mode" IN ('van_sell','pre_sell','both')),
	CONSTRAINT "van_days_cancelled_reason_chk" CHECK ("van_days"."status" <> 'cancelled' OR ("van_days"."status_reason" IS NOT NULL AND length(btrim("van_days"."status_reason")) > 0)),
	CONSTRAINT "van_days_van_chk" CHECK (("van_days"."mode" = 'pre_sell' AND "van_days"."van_id" IS NULL) OR ("van_days"."mode" <> 'pre_sell' AND "van_days"."van_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "van_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"stop_id" uuid,
	"sequence" integer NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"outcome" text,
	"no_sale_reason" text,
	"arrived_at" timestamp with time zone,
	"departed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "van_visits_status_chk" CHECK ("van_visits"."status" IN ('planned','arrived','done','skipped','closed_shop')),
	CONSTRAINT "van_visits_outcome_chk" CHECK ("van_visits"."outcome" IS NULL OR "van_visits"."outcome" IN ('sold','order_taken','sold_and_ordered','collected_only','no_sale')),
	CONSTRAINT "van_visits_sequence_chk" CHECK ("van_visits"."sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "van_day_events" ADD CONSTRAINT "van_day_events_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_events" ADD CONSTRAINT "van_day_events_day_id_van_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."van_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_days" ADD CONSTRAINT "van_days_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_days" ADD CONSTRAINT "van_days_route_id_sales_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."sales_routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_days" ADD CONSTRAINT "van_days_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_days" ADD CONSTRAINT "van_days_rep_id_sales_reps_id_fk" FOREIGN KEY ("rep_id") REFERENCES "public"."sales_reps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_days" ADD CONSTRAINT "van_days_van_id_vans_id_fk" FOREIGN KEY ("van_id") REFERENCES "public"."vans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_days" ADD CONSTRAINT "van_days_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_visits" ADD CONSTRAINT "van_visits_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_visits" ADD CONSTRAINT "van_visits_day_id_van_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."van_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_visits" ADD CONSTRAINT "van_visits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_visits" ADD CONSTRAINT "van_visits_stop_id_route_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."route_stops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "van_day_events_day_idx" ON "van_day_events" USING btree ("day_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "van_days_company_number_uidx" ON "van_days" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "van_days_rep_date_uidx" ON "van_days" USING btree ("rep_id","day_date") WHERE "van_days"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "van_days_van_date_uidx" ON "van_days" USING btree ("van_id","day_date") WHERE "van_days"."van_id" IS NOT NULL AND "van_days"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "van_days_route_date_uidx" ON "van_days" USING btree ("route_id","day_date") WHERE "van_days"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "van_days_company_date_idx" ON "van_days" USING btree ("company_id","day_date","id");--> statement-breakpoint
CREATE INDEX "van_days_route_idx" ON "van_days" USING btree ("route_id","status");--> statement-breakpoint
CREATE INDEX "van_days_rep_idx" ON "van_days" USING btree ("rep_id","status");--> statement-breakpoint
CREATE INDEX "van_days_van_idx" ON "van_days" USING btree ("van_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "van_visits_day_customer_uidx" ON "van_visits" USING btree ("day_id","customer_id");--> statement-breakpoint
CREATE INDEX "van_visits_day_idx" ON "van_visits" USING btree ("day_id","sequence","id");--> statement-breakpoint
CREATE INDEX "van_visits_customer_idx" ON "van_visits" USING btree ("customer_id","created_at");--> statement-breakpoint
-- What happened to a van day is kept as it happened: an entry is never changed and never deleted, so the day's history can always be trusted.
CREATE FUNCTION van_day_events_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The history of a van day is never changed or deleted' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER van_day_events_guard_trg BEFORE UPDATE OR DELETE ON van_day_events FOR EACH ROW EXECUTE FUNCTION van_day_events_guard();
