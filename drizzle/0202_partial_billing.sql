CREATE TABLE "billing_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"partial_billing" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_billing_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	CONSTRAINT "order_billing_lines_chk" CHECK ("order_billing_lines"."quantity" > 0 AND "order_billing_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_billings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"invoice_number" text NOT NULL,
	"goods_amount" numeric(14, 2) NOT NULL,
	"remainder_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"finishes_order" boolean DEFAULT false NOT NULL,
	"kra_status" text DEFAULT 'not_applicable' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_billings_amounts_chk" CHECK ("order_billings"."goods_amount" > 0 AND "order_billings"."remainder_amount" >= 0 AND "order_billings"."total_amount" = "order_billings"."goods_amount" + "order_billings"."remainder_amount")
);
--> statement-breakpoint
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_billing_lines" ADD CONSTRAINT "order_billing_lines_billing_id_order_billings_id_fk" FOREIGN KEY ("billing_id") REFERENCES "public"."order_billings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_billing_lines" ADD CONSTRAINT "order_billing_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_billings" ADD CONSTRAINT "order_billings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_billings" ADD CONSTRAINT "order_billings_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_billing_lines_billing_idx" ON "order_billing_lines" USING btree ("billing_id");--> statement-breakpoint
CREATE INDEX "order_billing_lines_item_idx" ON "order_billing_lines" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_billing_lines_billing_item_uidx" ON "order_billing_lines" USING btree ("billing_id","order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_billings_order_sequence_uidx" ON "order_billings" USING btree ("order_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "order_billings_invoice_number_uidx" ON "order_billings" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "order_billings_company_created_idx" ON "order_billings" USING btree ("company_id","created_at");--> statement-breakpoint
-- A part invoice is a tax document: it and its lines are never changed or deleted (only its KRA status is written, by signing).
CREATE FUNCTION order_billings_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A part invoice is never deleted' USING ERRCODE = '23001';
  END IF;
  IF NEW.order_id <> OLD.order_id OR NEW.sequence <> OLD.sequence OR NEW.invoice_number <> OLD.invoice_number OR NEW.goods_amount <> OLD.goods_amount OR NEW.remainder_amount <> OLD.remainder_amount OR NEW.tax_amount <> OLD.tax_amount OR NEW.total_amount <> OLD.total_amount OR NEW.finishes_order <> OLD.finishes_order THEN
    RAISE EXCEPTION 'A part invoice cannot be changed: correct it with a credit note' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER order_billings_guard_trg BEFORE UPDATE OR DELETE ON order_billings FOR EACH ROW EXECUTE FUNCTION order_billings_guard();
--> statement-breakpoint
CREATE FUNCTION order_billing_lines_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The lines of a part invoice cannot be changed: correct it with a credit note' USING ERRCODE = '23001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER order_billing_lines_guard_trg BEFORE UPDATE OR DELETE ON order_billing_lines FOR EACH ROW EXECUTE FUNCTION order_billing_lines_guard();
