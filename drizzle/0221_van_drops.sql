CREATE TABLE "van_drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"stock_state" text DEFAULT 'at_warehouse' NOT NULL,
	"hold_channel" text,
	"reason" text,
	"delivery_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "van_drops_state_chk" CHECK ("van_drops"."state" IN ('planned','delivered','partly','refused','failed')),
	CONSTRAINT "van_drops_stock_chk" CHECK ("van_drops"."stock_state" IN ('at_warehouse','on_the_way','on_van','short')),
	CONSTRAINT "van_drops_reason_chk" CHECK ("van_drops"."state" NOT IN ('refused','failed') OR ("van_drops"."reason" IS NOT NULL AND length(btrim("van_drops"."reason")) >= 3))
);
--> statement-breakpoint
ALTER TABLE "van_drops" ADD CONSTRAINT "van_drops_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_drops" ADD CONSTRAINT "van_drops_day_id_van_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."van_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_drops" ADD CONSTRAINT "van_drops_visit_id_van_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."van_visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_drops" ADD CONSTRAINT "van_drops_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "van_drops_live_order_uidx" ON "van_drops" USING btree ("order_id") WHERE "van_drops"."state" = 'planned';--> statement-breakpoint
CREATE INDEX "van_drops_day_idx" ON "van_drops" USING btree ("day_id","created_at");--> statement-breakpoint
CREATE INDEX "van_drops_visit_idx" ON "van_drops" USING btree ("visit_id");