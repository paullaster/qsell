CREATE TABLE "delivery_closed_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"day" date NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_closed_days_uidx" UNIQUE NULLS NOT DISTINCT("company_id","branch_id","day")
);
--> statement-breakpoint
CREATE TABLE "delivery_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"weekdays" integer[] NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"capacity" integer NOT NULL,
	"cutoff_minutes" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_slots_times_chk" CHECK ("delivery_slots"."starts_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "delivery_slots"."ends_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "delivery_slots"."ends_at" > "delivery_slots"."starts_at"),
	CONSTRAINT "delivery_slots_capacity_chk" CHECK ("delivery_slots"."capacity" BETWEEN 1 AND 10000 AND "delivery_slots"."cutoff_minutes" BETWEEN 0 AND 10080),
	CONSTRAINT "delivery_slots_weekdays_chk" CHECK (cardinality("delivery_slots"."weekdays") BETWEEN 1 AND 7 AND "delivery_slots"."weekdays" <@ ARRAY[1,2,3,4,5,6,7])
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "slot_id" uuid;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "slot_day" date;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "window_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "window_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "slot_booked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "slot_booked_by" text;--> statement-breakpoint
ALTER TABLE "delivery_closed_days" ADD CONSTRAINT "delivery_closed_days_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_closed_days" ADD CONSTRAINT "delivery_closed_days_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_slots" ADD CONSTRAINT "delivery_slots_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_slots" ADD CONSTRAINT "delivery_slots_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_closed_days_day_idx" ON "delivery_closed_days" USING btree ("company_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_slots_branch_name_uidx" ON "delivery_slots" USING btree ("company_id","branch_id","name");--> statement-breakpoint
CREATE INDEX "delivery_slots_branch_idx" ON "delivery_slots" USING btree ("company_id","branch_id","is_active");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_slot_id_delivery_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."delivery_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_slot_day_idx" ON "deliveries" USING btree ("slot_id","slot_day") WHERE "deliveries"."slot_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_slot_chk" CHECK (("deliveries"."slot_id" IS NULL) = ("deliveries"."slot_day" IS NULL) AND ("deliveries"."slot_id" IS NULL) = ("deliveries"."window_start" IS NULL) AND ("deliveries"."slot_id" IS NULL) = ("deliveries"."window_end" IS NULL) AND ("deliveries"."window_end" IS NULL OR "deliveries"."window_end" > "deliveries"."window_start"));