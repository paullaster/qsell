CREATE TABLE "delivery_lead_times" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"minutes" integer NOT NULL,
	"note" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_lead_times_kind_chk" CHECK ("delivery_lead_times"."kind" IN ('zone','item')),
	CONSTRAINT "delivery_lead_times_minutes_chk" CHECK ("delivery_lead_times"."minutes" BETWEEN 1 AND 43200)
);
--> statement-breakpoint
ALTER TABLE "delivery_slots" ADD COLUMN "max_weight_kg" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "delivery_lead_times" ADD CONSTRAINT "delivery_lead_times_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_lead_times_ref_uidx" ON "delivery_lead_times" USING btree ("company_id","kind","ref_id");--> statement-breakpoint
ALTER TABLE "delivery_slots" ADD CONSTRAINT "delivery_slots_weight_chk" CHECK ("delivery_slots"."max_weight_kg" IS NULL OR "delivery_slots"."max_weight_kg" > 0);