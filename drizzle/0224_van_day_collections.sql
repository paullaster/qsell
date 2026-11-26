CREATE TABLE "van_day_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"visit_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"method_kind" text NOT NULL,
	"movement_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "van_day_collections_amount_chk" CHECK ("van_day_collections"."amount" > 0),
	CONSTRAINT "van_day_collections_kind_chk" CHECK ("van_day_collections"."method_kind" IN ('cash','mobile_money','card')),
	CONSTRAINT "van_day_collections_cash_chk" CHECK (("van_day_collections"."method_kind" = 'cash') = ("van_day_collections"."movement_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "van_day_collections" ADD CONSTRAINT "van_day_collections_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_collections" ADD CONSTRAINT "van_day_collections_day_id_van_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."van_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_collections" ADD CONSTRAINT "van_day_collections_visit_id_van_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."van_visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_collections" ADD CONSTRAINT "van_day_collections_receipt_id_customer_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."customer_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_day_collections" ADD CONSTRAINT "van_day_collections_movement_id_shift_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."shift_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "van_day_collections_receipt_uidx" ON "van_day_collections" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "van_day_collections_movement_uidx" ON "van_day_collections" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "van_day_collections_day_idx" ON "van_day_collections" USING btree ("day_id","created_at");--> statement-breakpoint
CREATE INDEX "van_day_collections_visit_idx" ON "van_day_collections" USING btree ("visit_id");