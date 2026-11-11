CREATE TABLE "delivery_slot_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"shoppers_choose" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_slot_settings" ADD CONSTRAINT "delivery_slot_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;