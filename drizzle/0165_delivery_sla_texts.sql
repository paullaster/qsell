CREATE TABLE "delivery_sla_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"audience" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_try_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_sla_texts_audience_chk" CHECK ("delivery_sla_texts"."audience" IN ('staff','rider')),
	CONSTRAINT "delivery_sla_texts_status_chk" CHECK ("delivery_sla_texts"."status" IN ('queued','sent','failed')),
	CONSTRAINT "delivery_sla_texts_attempts_chk" CHECK ("delivery_sla_texts"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "delivery_sla_settings" ADD COLUMN "notify_dispatch_phones" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_sla_settings" ADD COLUMN "notify_supervisor_phones" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_sla_settings" ADD COLUMN "text_the_rider" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_sla_texts" ADD CONSTRAINT "delivery_sla_texts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sla_texts" ADD CONSTRAINT "delivery_sla_texts_event_id_delivery_sla_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."delivery_sla_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_sla_texts_once_uidx" ON "delivery_sla_texts" USING btree ("event_id","recipient");--> statement-breakpoint
CREATE INDEX "delivery_sla_texts_due_idx" ON "delivery_sla_texts" USING btree ("status","next_try_at");--> statement-breakpoint
ALTER TABLE "delivery_sla_settings" ADD CONSTRAINT "delivery_sla_settings_phones_chk" CHECK (cardinality("delivery_sla_settings"."notify_dispatch_phones") <= 10 AND cardinality("delivery_sla_settings"."notify_supervisor_phones") <= 10);