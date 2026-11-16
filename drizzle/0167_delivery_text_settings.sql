CREATE TABLE "delivery_text_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"kinds" text[] DEFAULT '{out_for_delivery,delivered,attempt_failed}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_text_settings_kinds_chk" CHECK ("delivery_text_settings"."kinds" <@ ARRAY['out_for_delivery','delivered','part_delivered','attempt_failed','returned','slot_not_kept']::text[])
);
--> statement-breakpoint
ALTER TABLE "delivery_text_settings" ADD CONSTRAINT "delivery_text_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;