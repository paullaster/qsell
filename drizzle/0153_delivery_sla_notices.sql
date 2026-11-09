CREATE TABLE "delivery_sla_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_try_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_sla_notices_status_chk" CHECK ("delivery_sla_notices"."status" IN ('queued','sent','failed')),
	CONSTRAINT "delivery_sla_notices_attempts_chk" CHECK ("delivery_sla_notices"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "delivery_sla_settings" DROP CONSTRAINT "delivery_sla_settings_chk";--> statement-breakpoint
ALTER TABLE "delivery_sla_settings" ADD COLUMN "notify_dispatch" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_sla_settings" ADD COLUMN "notify_supervisor" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_sla_notices" ADD CONSTRAINT "delivery_sla_notices_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sla_notices" ADD CONSTRAINT "delivery_sla_notices_event_id_delivery_sla_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."delivery_sla_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_sla_notices_once_uidx" ON "delivery_sla_notices" USING btree ("event_id","recipient");--> statement-breakpoint
CREATE INDEX "delivery_sla_notices_due_idx" ON "delivery_sla_notices" USING btree ("status","next_try_at");--> statement-breakpoint
ALTER TABLE "delivery_sla_settings" ADD CONSTRAINT "delivery_sla_settings_chk" CHECK ("delivery_sla_settings"."at_risk_minutes" BETWEEN 0 AND 1440 AND "delivery_sla_settings"."escalate_after_minutes" BETWEEN 1 AND 1440 AND cardinality("delivery_sla_settings"."notify_dispatch") <= 10 AND cardinality("delivery_sla_settings"."notify_supervisor") <= 10);