CREATE TABLE "delivery_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"delivery_id" uuid,
	"run_id" uuid,
	"rider_id" uuid,
	"courier_name" text,
	"note" text,
	"key" text NOT NULL,
	"reverses_id" uuid,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_costs_kind_chk" CHECK ("delivery_costs"."kind" IN ('rider_delivery','rider_day','courier','other')),
	CONSTRAINT "delivery_costs_amount_chk" CHECK ("delivery_costs"."amount" <> 0),
	CONSTRAINT "delivery_costs_rider_chk" CHECK ("delivery_costs"."kind" NOT IN ('rider_delivery','rider_day') OR "delivery_costs"."rider_id" IS NOT NULL),
	CONSTRAINT "delivery_costs_delivery_chk" CHECK ("delivery_costs"."kind" NOT IN ('rider_delivery','courier') OR "delivery_costs"."delivery_id" IS NOT NULL),
	CONSTRAINT "delivery_costs_courier_chk" CHECK ("delivery_costs"."kind" <> 'courier' OR "delivery_costs"."courier_name" IS NOT NULL),
	CONSTRAINT "delivery_costs_reversal_chk" CHECK (("delivery_costs"."reverses_id" IS NULL) = ("delivery_costs"."amount" > 0))
);
--> statement-breakpoint
CREATE TABLE "delivery_pay_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"per_delivery" numeric(14, 2) DEFAULT '0' NOT NULL,
	"per_day" numeric(14, 2) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_pay_settings_chk" CHECK ("delivery_pay_settings"."per_delivery" >= 0 AND "delivery_pay_settings"."per_day" >= 0)
);
--> statement-breakpoint
ALTER TABLE "delivery_costs" ADD CONSTRAINT "delivery_costs_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_costs" ADD CONSTRAINT "delivery_costs_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_costs" ADD CONSTRAINT "delivery_costs_run_id_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."delivery_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_costs" ADD CONSTRAINT "delivery_costs_rider_id_delivery_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."delivery_riders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_costs" ADD CONSTRAINT "delivery_costs_reverses_id_delivery_costs_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."delivery_costs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_pay_settings" ADD CONSTRAINT "delivery_pay_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_costs_key_uidx" ON "delivery_costs" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "delivery_costs_delivery_idx" ON "delivery_costs" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "delivery_costs_rider_idx" ON "delivery_costs" USING btree ("rider_id","created_at");--> statement-breakpoint
CREATE INDEX "delivery_costs_company_time_idx" ON "delivery_costs" USING btree ("company_id","created_at");--> statement-breakpoint
-- What delivery cost is kept for good, like every record of money here. A mistake is a reversing entry with its reason.
CREATE TRIGGER delivery_costs_no_change BEFORE UPDATE OR DELETE ON "delivery_costs" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
