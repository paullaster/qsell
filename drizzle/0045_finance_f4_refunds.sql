CREATE TABLE "refund_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "refund_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"refund_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"reason_code" text,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"order_id" text,
	"currency" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"payment_method_id" uuid NOT NULL,
	"payout_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"details_changed" boolean DEFAULT false NOT NULL,
	"branch_id" uuid,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"ledger_entry_id" uuid,
	"wallet_entry_id" bigint,
	"reserve_register_id" uuid,
	"paid_from_bank_account_id" uuid,
	"payout_reference" text,
	"payout_date" date,
	"paid_by" text,
	"paid_at" timestamp with time zone,
	"payout_register_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_requests_amount_chk" CHECK ("refund_requests"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "customer_credit_policies" ADD COLUMN "refunds_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_credit_policies" ADD COLUMN "wallet_cash_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_refund_id_refund_requests_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_paid_from_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("paid_from_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_events_refund_idx" ON "refund_events" USING btree ("refund_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_requests_company_number_uidx" ON "refund_requests" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_requests_idem_uidx" ON "refund_requests" USING btree ("company_id","idempotency_key") WHERE "refund_requests"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "refund_requests_status_idx" ON "refund_requests" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "refund_requests_source_idx" ON "refund_requests" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX "refund_requests_customer_idx" ON "refund_requests" USING btree ("customer_id","created_at");--> statement-breakpoint
-- A refund's history cannot be rewritten; a refund that has left draft keeps its money facts, and a
-- finished one (paid, rejected, cancelled) never changes again. None is ever deleted.
CREATE TRIGGER refund_events_append_only BEFORE UPDATE OR DELETE ON "refund_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE FUNCTION finance_guard_refund() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refunds cannot be deleted; cancel them' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('paid','cancelled') AND (NEW.status <> OLD.status OR NEW.amount <> OLD.amount) THEN
    RAISE EXCEPTION 'a % refund cannot change', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'rejected' AND (NEW.status NOT IN ('rejected','draft') OR NEW.amount <> OLD.amount) THEN
    RAISE EXCEPTION 'a % refund cannot change', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.amount <> OLD.amount OR NEW.customer_id <> OLD.customer_id OR NEW.source_kind <> OLD.source_kind
      OR NEW.source_id <> OLD.source_id OR NEW.currency <> OLD.currency OR NEW.number <> OLD.number) THEN
    RAISE EXCEPTION 'a refund that has been submitted keeps its amount, customer and source' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER refund_requests_guard BEFORE UPDATE OR DELETE ON "refund_requests" FOR EACH ROW EXECUTE FUNCTION finance_guard_refund();--> statement-breakpoint
-- Methods already set up for manual refunds can now be chosen for them.
UPDATE "payment_methods" SET "usable_for" = "usable_for" || '["customer_refund"]'::jsonb
WHERE "refund_destination" <> 'none' AND NOT ("usable_for" ? 'customer_refund');
