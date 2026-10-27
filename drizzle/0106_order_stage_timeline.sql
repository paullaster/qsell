CREATE TABLE "checkout_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel" text DEFAULT 'ecommerce' NOT NULL,
	"customer_id" text,
	"session_ref" text,
	"cart_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text DEFAULT 'started' NOT NULL,
	"refused_stage" text,
	"reason_code" text,
	"message" text,
	"order_id" text,
	"finished_at" timestamp with time zone,
	CONSTRAINT "checkout_attempts_outcome_chk" CHECK ("checkout_attempts"."outcome" IN ('started','refused','placed','abandoned_after_payment_start'))
);
--> statement-breakpoint
CREATE TABLE "order_stage_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_stage_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid,
	"order_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"back_dated" boolean DEFAULT false NOT NULL,
	"client_time" timestamp with time zone,
	"provider_time" timestamp with time zone,
	"source" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"reason_code" text,
	"message" text,
	"ref_type" text,
	"ref_id" text,
	"attempt_no" integer,
	"correlation_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approximate" boolean DEFAULT false NOT NULL,
	CONSTRAINT "order_stage_events_outcome_chk" CHECK ("order_stage_events"."outcome" IN ('entered','succeeded','failed','skipped','cancelled')),
	CONSTRAINT "order_stage_events_seq_chk" CHECK ("order_stage_events"."sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "packed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "current_stage" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "current_stage_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stage_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_stage_events" ADD CONSTRAINT "order_stage_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_attempts_started_idx" ON "checkout_attempts" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "checkout_attempts_outcome_idx" ON "checkout_attempts" USING btree ("outcome","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_stage_events_order_seq_uidx" ON "order_stage_events" USING btree ("order_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "order_stage_events_ref_uidx" ON "order_stage_events" USING btree ("order_id","stage","outcome","ref_type","ref_id") WHERE "order_stage_events"."ref_id" IS NOT NULL AND "order_stage_events"."stage" <> 'unrecorded_change';--> statement-breakpoint
CREATE INDEX "orders_stage_unseeded_idx" ON "orders" USING btree ("id") WHERE "orders"."stage_seq" = 0;--> statement-breakpoint
CREATE INDEX "order_stage_events_stage_idx" ON "order_stage_events" USING btree ("company_id","stage","outcome","occurred_at");--> statement-breakpoint
CREATE INDEX "order_stage_events_failed_idx" ON "order_stage_events" USING btree ("occurred_at") WHERE "order_stage_events"."outcome" = 'failed';--> statement-breakpoint
CREATE INDEX "order_stage_events_recorded_idx" ON "order_stage_events" USING brin ("recorded_at");
--> statement-breakpoint
ALTER TABLE "order_stage_events" ADD CONSTRAINT "order_stage_events_stage_chk" CHECK ("stage" IN ('checkout_started','checkout_validated','checkout_refused','order_placed','charge_quoted','pricing_applied','stock_reserved','reservation_failed','stock_issued','stock_released','stock_returned','approval_requested','approval_approved','approval_rejected','approval_escalated','approval_reopened','approval_withdrawn','payment_started','prompt_sent','payment_pending_verification','payment_confirmed','payment_failed','payment_expired','payment_retried','payment_reconciled','payment_discrepancy','refund_requested','refund_completed','refund_failed','released_for_fulfilment','blocked','unblocked','pick_started','picked','packed','ready','dispatched','out_for_delivery','delivery_attempted','delivered','delivery_failed','returned_to_stock','collected','invoice_issued','kra_submitted','kra_signed','kra_failed','credit_note_issued','completed','cancelled','failed','refunded','status_corrected','unrecorded_change'));--> statement-breakpoint
-- The timeline is kept: an event is never changed or removed. (A correction is a new event.)
CREATE FUNCTION order_stage_events_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order stage events are kept; they cannot be changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER order_stage_events_no_change BEFORE UPDATE OR DELETE ON "order_stage_events" FOR EACH ROW EXECUTE FUNCTION order_stage_events_guard();--> statement-breakpoint
-- A checkout attempt is finished once: started -> refused / placed / abandoned.
CREATE FUNCTION checkout_attempts_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.outcome <> 'started' THEN
    RAISE EXCEPTION 'a finished checkout attempt cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER checkout_attempts_finish_once BEFORE UPDATE ON "checkout_attempts" FOR EACH ROW EXECUTE FUNCTION checkout_attempts_guard();--> statement-breakpoint
-- The safety net. The stage writer raises stage_seq in the same UPDATE that changes a stage column. A change that did not
-- (some code path went round the writer) is recorded here, flagged as 'unrecorded_change' from source 'trigger', so a
-- bypass is seen within the day and never lost. The sale itself is never refused over it.
CREATE FUNCTION orders_guard_stage_change() RETURNS trigger AS $$
DECLARE
  changes jsonb := '{}'::jsonb;
BEGIN
  IF NEW.stage_seq <> OLD.stage_seq THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    changes := changes || jsonb_build_object('status', jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    changes := changes || jsonb_build_object('payment_status', jsonb_build_object('from', OLD.payment_status, 'to', NEW.payment_status));
  END IF;
  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    changes := changes || jsonb_build_object('approval_status', jsonb_build_object('from', OLD.approval_status, 'to', NEW.approval_status));
  END IF;
  IF NEW.kra_transmission_status IS DISTINCT FROM OLD.kra_transmission_status THEN
    changes := changes || jsonb_build_object('kra_transmission_status', jsonb_build_object('from', OLD.kra_transmission_status, 'to', NEW.kra_transmission_status));
  END IF;
  IF changes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;
  NEW.stage_seq := OLD.stage_seq + 1;
  NEW.current_stage := 'unrecorded_change';
  NEW.current_stage_since := now();
  INSERT INTO order_stage_events (company_id, order_id, sequence, stage, outcome, from_status, to_status, changes, source, actor_type, message)
  VALUES (
    (SELECT b.company_id FROM branches b WHERE b.id = NEW.branch_id),
    NEW.id, NEW.stage_seq, 'unrecorded_change', 'succeeded',
    CASE WHEN changes ? 'status' THEN OLD.status END,
    CASE WHEN changes ? 'status' THEN NEW.status END,
    changes, 'trigger', 'system',
    'A stage column was changed without going through the order stage writer.'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER orders_stage_change_guard BEFORE UPDATE OF status, payment_status, approval_status, kra_transmission_status ON "orders" FOR EACH ROW EXECUTE FUNCTION orders_guard_stage_change();
