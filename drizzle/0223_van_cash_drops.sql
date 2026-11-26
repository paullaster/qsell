CREATE TABLE "van_cash_drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"destination" text NOT NULL,
	"note" text,
	"witnessed_by" text,
	"witnessed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "van_cash_drops_amount_chk" CHECK ("van_cash_drops"."amount" > 0),
	CONSTRAINT "van_cash_drops_destination_chk" CHECK ("van_cash_drops"."destination" IN ('safe','bank_run','office')),
	CONSTRAINT "van_cash_drops_witness_chk" CHECK (("van_cash_drops"."witnessed_by" IS NULL) = ("van_cash_drops"."witnessed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "van_cash_drops" ADD CONSTRAINT "van_cash_drops_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_cash_drops" ADD CONSTRAINT "van_cash_drops_day_id_van_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."van_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_cash_drops" ADD CONSTRAINT "van_cash_drops_movement_id_shift_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."shift_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "van_cash_drops_movement_uidx" ON "van_cash_drops" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "van_cash_drops_day_idx" ON "van_cash_drops" USING btree ("day_id","created_at");