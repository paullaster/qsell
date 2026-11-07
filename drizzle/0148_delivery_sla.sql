CREATE TABLE "delivery_sla_acks" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"acknowledged_by" text NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "delivery_sla_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"level" text NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"minutes_late" integer DEFAULT 0 NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_sla_events_level_chk" CHECK ("delivery_sla_events"."level" IN ('at_risk','late','escalated'))
);
--> statement-breakpoint
CREATE TABLE "delivery_sla_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"at_risk_minutes" integer DEFAULT 60 NOT NULL,
	"escalate_after_minutes" integer DEFAULT 60 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_sla_settings_chk" CHECK ("delivery_sla_settings"."at_risk_minutes" BETWEEN 0 AND 1440 AND "delivery_sla_settings"."escalate_after_minutes" BETWEEN 1 AND 1440)
);
--> statement-breakpoint
ALTER TABLE "delivery_sla_acks" ADD CONSTRAINT "delivery_sla_acks_event_id_delivery_sla_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."delivery_sla_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sla_events" ADD CONSTRAINT "delivery_sla_events_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sla_events" ADD CONSTRAINT "delivery_sla_events_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sla_settings" ADD CONSTRAINT "delivery_sla_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_sla_events_once_uidx" ON "delivery_sla_events" USING btree ("delivery_id","level","window_end");--> statement-breakpoint
CREATE INDEX "delivery_sla_events_company_idx" ON "delivery_sla_events" USING btree ("company_id","raised_at" DESC NULLS LAST);--> statement-breakpoint
-- What was raised, and what was said about it, is kept for good.
CREATE TRIGGER delivery_sla_events_no_change BEFORE UPDATE OR DELETE ON "delivery_sla_events" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();--> statement-breakpoint
CREATE TRIGGER delivery_sla_acks_no_change BEFORE UPDATE OR DELETE ON "delivery_sla_acks" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
