CREATE TABLE "rider_pins" (
	"rider_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"pin_hash" text NOT NULL,
	"must_change" boolean DEFAULT true NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"last_signed_in_at" timestamp with time zone,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_pins_phone_chk" CHECK ("rider_pins"."phone" ~ '^254[17][0-9]{8}$'),
	CONSTRAINT "rider_pins_failed_chk" CHECK ("rider_pins"."failed_attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "rider_pins" ADD CONSTRAINT "rider_pins_rider_id_delivery_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."delivery_riders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rider_pins" ADD CONSTRAINT "rider_pins_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rider_pins_phone_uidx" ON "rider_pins" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "rider_pins_company_idx" ON "rider_pins" USING btree ("company_id");