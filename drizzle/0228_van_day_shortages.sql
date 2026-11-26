CREATE TABLE "van_day_shortages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"load_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"rule" text NOT NULL,
	"needs_approval" boolean DEFAULT false NOT NULL,
	"decision" text,
	"reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"charged_rep_id" uuid,
	"charged_amount" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "van_day_shortages_quantity_chk" CHECK ("van_day_shortages"."quantity" > 0 AND "van_day_shortages"."value" >= 0 AND "van_day_shortages"."unit_cost" >= 0),
	CONSTRAINT "van_day_shortages_rule_chk" CHECK ("van_day_shortages"."rule" IN ('charge_rep','write_off')),
	CONSTRAINT "van_day_shortages_decision_chk" CHECK ("van_day_shortages"."decision" IS NULL OR "van_day_shortages"."decision" IN ('charge_rep','write_off')),
	CONSTRAINT "van_day_shortages_decided_chk" CHECK (("van_day_shortages"."decision" IS NULL) = ("van_day_shortages"."decided_by" IS NULL) AND ("van_day_shortages"."decision" IS NULL) = ("van_day_shortages"."decided_at" IS NULL) AND ("van_day_shortages"."decision" IS NULL) = ("van_day_shortages"."reason" IS NULL)),
	CONSTRAINT "van_day_shortages_charge_chk" CHECK (("van_day_shortages"."charged_amount" IS NULL) = ("van_day_shortages"."decision" IS DISTINCT FROM 'charge_rep') AND ("van_day_shortages"."charged_rep_id" IS NULL) = ("van_day_shortages"."charged_amount" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "van_day_shortages" ADD CONSTRAINT "van_day_shortages_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_shortages" ADD CONSTRAINT "van_day_shortages_day_id_van_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."van_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_shortages" ADD CONSTRAINT "van_day_shortages_load_id_van_loads_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."van_loads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_shortages" ADD CONSTRAINT "van_day_shortages_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_shortages" ADD CONSTRAINT "van_day_shortages_charged_rep_id_sales_reps_id_fk" FOREIGN KEY ("charged_rep_id") REFERENCES "public"."sales_reps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "van_day_shortages_line_uidx" ON "van_day_shortages" USING btree ("load_id","product_id");--> statement-breakpoint
CREATE INDEX "van_day_shortages_day_idx" ON "van_day_shortages" USING btree ("day_id","created_at");