CREATE TABLE "counter_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"credit_note_id" uuid,
	"refund_id" uuid,
	"shift_id" uuid,
	"requested_by" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"restock" boolean NOT NULL,
	"stock_back" boolean DEFAULT false NOT NULL,
	"refund_method_id" uuid,
	"payout_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"cash_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"lines" jsonb NOT NULL,
	"status" text DEFAULT 'credited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counter_returns_status_chk" CHECK ("counter_returns"."status" IN ('credited', 'refund_pending', 'refund_approved', 'completed')),
	CONSTRAINT "counter_returns_cash_chk" CHECK ("counter_returns"."cash_paid" >= 0 AND "counter_returns"."cash_paid" <= "counter_returns"."amount" AND ("counter_returns"."cash_paid" = 0 OR "counter_returns"."shift_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "counter_returns" ADD CONSTRAINT "counter_returns_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_returns" ADD CONSTRAINT "counter_returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_returns" ADD CONSTRAINT "counter_returns_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_returns" ADD CONSTRAINT "counter_returns_refund_id_refund_requests_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_returns" ADD CONSTRAINT "counter_returns_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_returns" ADD CONSTRAINT "counter_returns_refund_method_id_payment_methods_id_fk" FOREIGN KEY ("refund_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "counter_returns_key_uidx" ON "counter_returns" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "counter_returns_order_idx" ON "counter_returns" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "counter_returns_shift_idx" ON "counter_returns" USING btree ("shift_id") WHERE "counter_returns"."shift_id" IS NOT NULL;--> statement-breakpoint
-- Cash handed back at the till comes out of a shift that is open, once: a closed shift, and the Z report made from it, never change.
CREATE FUNCTION counter_returns_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A return at the till is never deleted' USING ERRCODE = '23001';
  END IF;
  IF NEW.cash_paid > 0 THEN
    IF TG_OP = 'INSERT' OR OLD.cash_paid = 0 THEN
      IF (SELECT status FROM shifts WHERE id = NEW.shift_id) IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'Cash can only be handed back from a shift that is open' USING ERRCODE = '23001';
      END IF;
    ELSIF NEW.cash_paid <> OLD.cash_paid OR NEW.shift_id IS DISTINCT FROM OLD.shift_id THEN
      RAISE EXCEPTION 'The cash handed back for a return cannot be changed' USING ERRCODE = '23001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER counter_returns_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON counter_returns FOR EACH ROW EXECUTE FUNCTION counter_returns_guard();
