CREATE TABLE "offline_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"sale_key" text NOT NULL,
	"device_ref" text NOT NULL,
	"device_time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"status" text NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"order_id" text,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offline_sales_status_chk" CHECK ("offline_sales"."status" IN ('accepted', 'needs_review', 'parked', 'rejected', 'discarded')),
	CONSTRAINT "offline_sales_total_chk" CHECK ("offline_sales"."total" > 0)
);
--> statement-breakpoint
CREATE TABLE "offline_selling_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_per_shift" numeric(14, 2) DEFAULT '50000' NOT NULL,
	"max_hours" integer DEFAULT 24 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offline_shift_keys" (
	"shift_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offline_sales" ADD CONSTRAINT "offline_sales_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_sales" ADD CONSTRAINT "offline_sales_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_sales" ADD CONSTRAINT "offline_sales_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_selling_settings" ADD CONSTRAINT "offline_selling_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_shift_keys" ADD CONSTRAINT "offline_shift_keys_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offline_shift_keys" ADD CONSTRAINT "offline_shift_keys_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offline_sales_key_uidx" ON "offline_sales" USING btree ("sale_key");--> statement-breakpoint
CREATE INDEX "offline_sales_shift_idx" ON "offline_sales" USING btree ("shift_id","status");--> statement-breakpoint
CREATE INDEX "offline_sales_review_idx" ON "offline_sales" USING btree ("company_id","received_at") WHERE "offline_sales"."status" IN ('needs_review', 'parked', 'rejected');--> statement-breakpoint
-- An offline sale is kept as it arrived: what it was, whose and for how much never change, and it is never deleted (only its outcome is written).
CREATE FUNCTION offline_sales_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An offline sale is never deleted' USING ERRCODE = '23001';
  END IF;
  IF NEW.sale_key <> OLD.sale_key OR NEW.shift_id <> OLD.shift_id OR NEW.total <> OLD.total OR NEW.payload <> OLD.payload OR NEW.device_time <> OLD.device_time OR NEW.device_ref <> OLD.device_ref THEN
    RAISE EXCEPTION 'An offline sale cannot be changed after it was received' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER offline_sales_guard_trg BEFORE UPDATE OR DELETE ON offline_sales FOR EACH ROW EXECUTE FUNCTION offline_sales_guard();
