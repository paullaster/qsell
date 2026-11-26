CREATE TABLE "van_day_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"counter_return_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"restock" boolean NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "van_day_returns_amount_chk" CHECK ("van_day_returns"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "van_visits" DROP CONSTRAINT "van_visits_outcome_chk";--> statement-breakpoint
ALTER TABLE "van_day_returns" ADD CONSTRAINT "van_day_returns_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_returns" ADD CONSTRAINT "van_day_returns_day_id_van_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."van_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_returns" ADD CONSTRAINT "van_day_returns_visit_id_van_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."van_visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_returns" ADD CONSTRAINT "van_day_returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_returns" ADD CONSTRAINT "van_day_returns_counter_return_id_counter_returns_id_fk" FOREIGN KEY ("counter_return_id") REFERENCES "public"."counter_returns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "van_day_returns_return_uidx" ON "van_day_returns" USING btree ("counter_return_id");--> statement-breakpoint
CREATE INDEX "van_day_returns_day_idx" ON "van_day_returns" USING btree ("day_id","created_at");--> statement-breakpoint
CREATE INDEX "van_day_returns_visit_idx" ON "van_day_returns" USING btree ("visit_id");--> statement-breakpoint
ALTER TABLE "van_visits" ADD CONSTRAINT "van_visits_outcome_chk" CHECK ("van_visits"."outcome" IS NULL OR "van_visits"."outcome" IN ('sold','order_taken','sold_and_ordered','delivered_only','collected_only','returned_only','no_sale'));