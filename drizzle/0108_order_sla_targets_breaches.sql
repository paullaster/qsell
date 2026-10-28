CREATE TABLE "order_sla_breaches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"stage" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"target_minutes" integer NOT NULL,
	"escalate_after_minutes" integer NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"escalated_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"note" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "order_sla_breaches_note_chk" CHECK ("order_sla_breaches"."note" IS NULL OR length("order_sla_breaches"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "order_sla_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"raise_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"escalate_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "order_stage_targets" (
	"company_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"target_minutes" integer NOT NULL,
	"escalate_after_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "order_stage_targets_company_id_stage_pk" PRIMARY KEY("company_id","stage"),
	CONSTRAINT "order_stage_targets_target_chk" CHECK ("order_stage_targets"."target_minutes" BETWEEN 5 AND 129600),
	CONSTRAINT "order_stage_targets_escalate_chk" CHECK ("order_stage_targets"."escalate_after_minutes" BETWEEN 5 AND 43200)
);
--> statement-breakpoint
ALTER TABLE "order_sla_breaches" ADD CONSTRAINT "order_sla_breaches_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_sla_breaches_episode_uidx" ON "order_sla_breaches" USING btree ("order_id","stage","entered_at");--> statement-breakpoint
CREATE INDEX "order_sla_breaches_open_idx" ON "order_sla_breaches" USING btree ("company_id","raised_at") WHERE "order_sla_breaches"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "order_sla_breaches_resolved_idx" ON "order_sla_breaches" USING btree ("resolved_at") WHERE "order_sla_breaches"."resolved_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_stage_since_idx" ON "orders" USING btree ("current_stage","current_stage_since") WHERE "orders"."current_stage" IS NOT NULL;