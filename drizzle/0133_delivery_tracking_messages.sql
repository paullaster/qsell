CREATE TABLE "delivery_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"delivery_id" uuid,
	"kind" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"recipient" text,
	"message_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_try_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_messages_status_chk" CHECK ("delivery_messages"."status" IN ('queued','sent','failed','skipped')),
	CONSTRAINT "delivery_messages_attempts_chk" CHECK ("delivery_messages"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_tracking_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"token_sealed" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"views" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_tracking_links_views_chk" CHECK ("order_tracking_links"."views" >= 0)
);
--> statement-breakpoint
ALTER TABLE "delivery_messages" ADD CONSTRAINT "delivery_messages_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_messages" ADD CONSTRAINT "delivery_messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_messages" ADD CONSTRAINT "delivery_messages_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_tracking_links" ADD CONSTRAINT "order_tracking_links_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_tracking_links" ADD CONSTRAINT "order_tracking_links_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_messages_key_uidx" ON "delivery_messages" USING btree ("company_id","message_key");--> statement-breakpoint
CREATE INDEX "delivery_messages_due_idx" ON "delivery_messages" USING btree ("status","next_try_at");--> statement-breakpoint
CREATE INDEX "delivery_messages_delivery_idx" ON "delivery_messages" USING btree ("delivery_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_tracking_links_order_uidx" ON "order_tracking_links" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_tracking_links_hash_uidx" ON "order_tracking_links" USING btree ("token_hash");