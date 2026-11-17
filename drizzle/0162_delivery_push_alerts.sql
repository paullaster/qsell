CREATE TABLE "delivery_sla_pushes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_try_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_sla_pushes_audience_chk" CHECK ("delivery_sla_pushes"."audience" IN ('staff','rider')),
	CONSTRAINT "delivery_sla_pushes_status_chk" CHECK ("delivery_sla_pushes"."status" IN ('queued','sent','failed')),
	CONSTRAINT "delivery_sla_pushes_attempts_chk" CHECK ("delivery_sla_pushes"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_endpoint_chk" CHECK (char_length("push_subscriptions"."endpoint") BETWEEN 10 AND 2048 AND "push_subscriptions"."endpoint" LIKE 'https://%')
);
--> statement-breakpoint
ALTER TABLE "delivery_sla_pushes" ADD CONSTRAINT "delivery_sla_pushes_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sla_pushes" ADD CONSTRAINT "delivery_sla_pushes_event_id_delivery_sla_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."delivery_sla_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_sla_pushes" ADD CONSTRAINT "delivery_sla_pushes_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_sla_pushes_once_uidx" ON "delivery_sla_pushes" USING btree ("event_id","subscription_id");--> statement-breakpoint
CREATE INDEX "delivery_sla_pushes_due_idx" ON "delivery_sla_pushes" USING btree ("status","next_try_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_uidx" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("company_id","user_id");