CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"number" text NOT NULL,
	"method" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"destination" jsonb NOT NULL,
	"recipient_name" text,
	"recipient_phone" text,
	"notes" text,
	"courier_name" text,
	"tracking_number" text,
	"received_by" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"released_at" timestamp with time zone,
	"packed_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_status_chk" CHECK ("deliveries"."status" IN ('draft','released','picking','packed','ready','out_for_delivery','delivered','failed_attempt','returned','cancelled')),
	CONSTRAINT "deliveries_method_chk" CHECK ("deliveries"."method" IN ('own_fleet','courier')),
	CONSTRAINT "deliveries_attempts_chk" CHECK ("deliveries"."failed_attempts" >= 0),
	CONSTRAINT "deliveries_version_chk" CHECK ("deliveries"."version" >= 1),
	CONSTRAINT "deliveries_delivered_chk" CHECK (("deliveries"."status" = 'delivered') = ("deliveries"."delivered_at" IS NOT NULL)),
	CONSTRAINT "deliveries_closed_chk" CHECK ("deliveries"."status" NOT IN ('delivered','returned','cancelled') OR "deliveries"."closed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "delivery_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "delivery_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"delivery_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"reason_code" text,
	"note" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_events_sequence_chk" CHECK ("delivery_events"."sequence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "delivery_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"picked" numeric(14, 3),
	"delivered" numeric(14, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "delivery_lines_quantity_chk" CHECK ("delivery_lines"."quantity" > 0),
	CONSTRAINT "delivery_lines_picked_chk" CHECK ("delivery_lines"."picked" IS NULL OR ("delivery_lines"."picked" >= 0 AND "delivery_lines"."picked" <= "delivery_lines"."quantity")),
	CONSTRAINT "delivery_lines_delivered_chk" CHECK ("delivery_lines"."delivered" >= 0 AND "delivery_lines"."delivered" <= COALESCE("delivery_lines"."picked", "delivery_lines"."quantity"))
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_company_number_uidx" ON "deliveries" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "deliveries_order_idx" ON "deliveries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "deliveries_company_status_idx" ON "deliveries" USING btree ("company_id","status","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "deliveries_company_branch_status_idx" ON "deliveries" USING btree ("company_id","branch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_events_delivery_seq_uidx" ON "delivery_events" USING btree ("delivery_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_lines_delivery_product_uidx" ON "delivery_lines" USING btree ("delivery_id","product_id");--> statement-breakpoint
CREATE INDEX "delivery_lines_product_idx" ON "delivery_lines" USING btree ("product_id");
--> statement-breakpoint
-- A part of an order can be delivered while the rest is not, so the timeline has a stage of its own for it; it does not move the order's status.
ALTER TABLE "order_stage_events" DROP CONSTRAINT "order_stage_events_stage_chk";--> statement-breakpoint
ALTER TABLE "order_stage_events" ADD CONSTRAINT "order_stage_events_stage_chk" CHECK ("stage" IN ('checkout_started','checkout_validated','checkout_refused','order_placed','charge_quoted','pricing_applied','stock_reserved','reservation_failed','stock_issued','stock_released','stock_returned','approval_requested','approval_approved','approval_rejected','approval_escalated','approval_reopened','approval_withdrawn','payment_started','prompt_sent','payment_pending_verification','payment_confirmed','payment_failed','payment_expired','payment_retried','payment_reconciled','payment_discrepancy','refund_requested','refund_completed','refund_failed','released_for_fulfilment','blocked','unblocked','pick_started','picked','packed','ready','dispatched','out_for_delivery','delivery_attempted','delivered','part_delivered','delivery_failed','returned_to_stock','collected','invoice_issued','kra_submitted','kra_signed','kra_failed','delivery_invoice_signed','delivery_invoice_failed','delivery_invoice_skipped','credit_note_issued','completed','cancelled','failed','refunded','status_corrected','unrecorded_change'));--> statement-breakpoint
-- A delivery's history is kept: an event is never changed or removed. (A correction is a new event.)
CREATE FUNCTION delivery_events_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'delivery events are kept; they cannot be changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER delivery_events_no_change BEFORE UPDATE OR DELETE ON "delivery_events" FOR EACH ROW EXECUTE FUNCTION delivery_events_guard();--> statement-breakpoint
-- A finished delivery (delivered, returned or cancelled) is not reopened.
CREATE FUNCTION deliveries_finished_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('delivered','returned','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a % delivery cannot change its state', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER deliveries_finished BEFORE UPDATE ON "deliveries" FOR EACH ROW EXECUTE FUNCTION deliveries_finished_guard();
