CREATE TABLE "cash_custody_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"rider_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"delivery_id" uuid,
	"order_id" text,
	"key" text NOT NULL,
	"note" text,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_custody_kind_chk" CHECK ("cash_custody_entries"."kind" IN ('collected','handed_in','adjusted')),
	CONSTRAINT "cash_custody_sign_chk" CHECK (("cash_custody_entries"."kind" = 'collected' AND "cash_custody_entries"."amount" > 0) OR ("cash_custody_entries"."kind" = 'handed_in' AND "cash_custody_entries"."amount" < 0) OR ("cash_custody_entries"."kind" = 'adjusted' AND "cash_custody_entries"."amount" <> 0)),
	CONSTRAINT "cash_custody_collected_chk" CHECK ("cash_custody_entries"."kind" <> 'collected' OR ("cash_custody_entries"."delivery_id" IS NOT NULL AND "cash_custody_entries"."order_id" IS NOT NULL)),
	CONSTRAINT "cash_custody_adjust_chk" CHECK ("cash_custody_entries"."kind" <> 'adjusted' OR "cash_custody_entries"."note" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "delivery_door_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"cash_method_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "door_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "door_marked_by" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "door_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "door_reason" text;--> statement-breakpoint
ALTER TABLE "cash_custody_entries" ADD CONSTRAINT "cash_custody_entries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_custody_entries" ADD CONSTRAINT "cash_custody_entries_rider_id_delivery_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."delivery_riders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_custody_entries" ADD CONSTRAINT "cash_custody_entries_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_custody_entries" ADD CONSTRAINT "cash_custody_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_door_settings" ADD CONSTRAINT "delivery_door_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_door_settings" ADD CONSTRAINT "delivery_door_settings_cash_method_id_payment_methods_id_fk" FOREIGN KEY ("cash_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_custody_key_uidx" ON "cash_custody_entries" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "cash_custody_rider_idx" ON "cash_custody_entries" USING btree ("rider_id","created_at");--> statement-breakpoint
CREATE INDEX "cash_custody_delivery_idx" ON "cash_custody_entries" USING btree ("delivery_id");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_door_chk" CHECK (("deliveries"."door_amount" IS NULL) = ("deliveries"."door_marked_at" IS NULL) AND ("deliveries"."door_amount" IS NULL OR "deliveries"."door_amount" > 0));--> statement-breakpoint
-- Cash in a rider's hands is kept like every other record of money: never changed or removed. A mistake is an adjustment with its reason.
CREATE TRIGGER cash_custody_no_change BEFORE UPDATE OR DELETE ON "cash_custody_entries" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
