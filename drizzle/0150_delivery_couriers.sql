CREATE TABLE "courier_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"adapter" text DEFAULT 'manual' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_sealed" jsonb,
	"webhook_key" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_accounts_adapter_chk" CHECK ("courier_accounts"."adapter" IN ('manual','http_json'))
);
--> statement-breakpoint
CREATE TABLE "courier_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"source" text NOT NULL,
	"dedup_key" text NOT NULL,
	"state" text NOT NULL,
	"note" text,
	"courier_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "courier_events_source_chk" CHECK ("courier_events"."source" IN ('webhook','poll'))
);
--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "label_url" text;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "tracking_url" text;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "pod_url" text;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "pod_name" text;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "sync_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "sync_tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "sync_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD COLUMN "sync_error" text;--> statement-breakpoint
ALTER TABLE "courier_accounts" ADD CONSTRAINT "courier_accounts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_events" ADD CONSTRAINT "courier_events_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_events" ADD CONSTRAINT "courier_events_shipment_id_delivery_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."delivery_shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_accounts_name_uidx" ON "courier_accounts" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "courier_accounts_webhook_uidx" ON "courier_accounts" USING btree ("webhook_key");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_events_once_uidx" ON "courier_events" USING btree ("shipment_id","dedup_key");--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD CONSTRAINT "delivery_shipments_account_id_courier_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."courier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_shipments_sync_idx" ON "delivery_shipments" USING btree ("sync_next_at") WHERE "delivery_shipments"."account_id" IS NOT NULL AND "delivery_shipments"."sync_next_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "delivery_shipments_tracking_idx" ON "delivery_shipments" USING btree ("account_id","tracking_number") WHERE "delivery_shipments"."account_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_shipments" ADD CONSTRAINT "delivery_shipments_sync_chk" CHECK ("delivery_shipments"."sync_state" IN ('idle','book_pending','book_failed','cancel_pending','cancel_failed','cancelled'));
--> statement-breakpoint
-- What a courier told us is kept as it came.
CREATE TRIGGER courier_events_no_change BEFORE UPDATE OR DELETE ON "courier_events" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
