CREATE TABLE "van_day_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "van_day_orders_kind_chk" CHECK ("van_day_orders"."kind" IN ('cash','credit')),
	CONSTRAINT "van_day_orders_total_chk" CHECK ("van_day_orders"."total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "van_day_orders" ADD CONSTRAINT "van_day_orders_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_orders" ADD CONSTRAINT "van_day_orders_day_id_van_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."van_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_orders" ADD CONSTRAINT "van_day_orders_visit_id_van_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."van_visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_orders" ADD CONSTRAINT "van_day_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "van_day_orders_order_uidx" ON "van_day_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "van_day_orders_day_idx" ON "van_day_orders" USING btree ("day_id","created_at");--> statement-breakpoint
CREATE INDEX "van_day_orders_visit_idx" ON "van_day_orders" USING btree ("visit_id");