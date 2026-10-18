CREATE TABLE "credit_adjustment_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credit_adjustment_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"adjustment_id" uuid NOT NULL,
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
CREATE TABLE "credit_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"customer_id" uuid NOT NULL,
	"source_kind" text,
	"source_id" text,
	"currency" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"register_id" uuid,
	"wallet_entry_id" bigint,
	"ledger_entry_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_adjustments_amount_chk" CHECK ("credit_adjustments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "refund_payment_file_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"beneficiary" jsonb NOT NULL,
	"end_to_end_id" text NOT NULL,
	"state" text DEFAULT 'in_file' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refund_payment_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"method_id" uuid NOT NULL,
	"format" text NOT NULL,
	"currency" text NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"item_count" integer NOT NULL,
	"status" text DEFAULT 'generated' NOT NULL,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"downloads" integer DEFAULT 0 NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"bank_reference" text,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text
);
--> statement-breakpoint
CREATE TABLE "refund_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"replacement_refund_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"returned_on" date NOT NULL,
	"reference" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"received_into_method_id" uuid NOT NULL,
	"register_id" uuid,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_returns_amount_chk" CHECK ("refund_returns"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "customer_credit_policies" ADD COLUMN "expiry_days" integer;--> statement-breakpoint
ALTER TABLE "customer_credit_policies" ADD COLUMN "expiry_notice_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD COLUMN "credit_forfeit_account_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD COLUMN "credit_adjustment_account_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_adjustment_events" ADD CONSTRAINT "credit_adjustment_events_adjustment_id_credit_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."credit_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_adjustments" ADD CONSTRAINT "credit_adjustments_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_adjustments" ADD CONSTRAINT "credit_adjustments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payment_file_items" ADD CONSTRAINT "refund_payment_file_items_file_id_refund_payment_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."refund_payment_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payment_file_items" ADD CONSTRAINT "refund_payment_file_items_refund_id_refund_requests_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payment_files" ADD CONSTRAINT "refund_payment_files_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_payment_files" ADD CONSTRAINT "refund_payment_files_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_returns" ADD CONSTRAINT "refund_returns_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_returns" ADD CONSTRAINT "refund_returns_refund_id_refund_requests_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refund_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_returns" ADD CONSTRAINT "refund_returns_replacement_refund_id_refund_requests_id_fk" FOREIGN KEY ("replacement_refund_id") REFERENCES "public"."refund_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_returns" ADD CONSTRAINT "refund_returns_received_into_method_id_payment_methods_id_fk" FOREIGN KEY ("received_into_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_adjustment_events_adjustment_idx" ON "credit_adjustment_events" USING btree ("adjustment_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_adjustments_company_number_uidx" ON "credit_adjustments" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_adjustments_idem_uidx" ON "credit_adjustments" USING btree ("company_id","idempotency_key") WHERE "credit_adjustments"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "credit_adjustments_status_idx" ON "credit_adjustments" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "credit_adjustments_source_idx" ON "credit_adjustments" USING btree ("source_kind","source_id");--> statement-breakpoint
CREATE INDEX "credit_adjustments_customer_idx" ON "credit_adjustments" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "refund_payment_file_items_file_idx" ON "refund_payment_file_items" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_payment_file_items_one_live_uidx" ON "refund_payment_file_items" USING btree ("refund_id") WHERE "refund_payment_file_items"."state" = 'in_file';--> statement-breakpoint
CREATE UNIQUE INDEX "refund_payment_files_company_number_uidx" ON "refund_payment_files" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "refund_payment_files_status_idx" ON "refund_payment_files" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "refund_returns_refund_idx" ON "refund_returns" USING btree ("refund_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_returns_reference_uidx" ON "refund_returns" USING btree ("company_id","received_into_method_id","reference");--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_credit_forfeit_account_id_gl_accounts_id_fk" FOREIGN KEY ("credit_forfeit_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_credit_adjustment_account_id_gl_accounts_id_fk" FOREIGN KEY ("credit_adjustment_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_wallets_dormant_idx" ON "customer_wallets" USING btree ("company_id","updated_at") WHERE "customer_wallets"."balance" > 0;
--> statement-breakpoint
-- A credit adjustment's history cannot be rewritten; once decided it never changes; none is ever deleted.
CREATE TRIGGER credit_adjustment_events_append_only BEFORE UPDATE OR DELETE ON "credit_adjustment_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE FUNCTION finance_guard_credit_adjustment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'credit adjustments cannot be deleted; cancel them' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('applied','rejected','cancelled') AND (NEW.status <> OLD.status OR NEW.amount <> OLD.amount) THEN
    RAISE EXCEPTION 'a % credit adjustment cannot change', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amount <> OLD.amount OR NEW.customer_id <> OLD.customer_id OR NEW.kind <> OLD.kind OR NEW.currency <> OLD.currency
     OR NEW.number <> OLD.number OR NEW.source_kind IS DISTINCT FROM OLD.source_kind OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'a credit adjustment keeps its kind, amount, customer, source and requester' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER credit_adjustments_guard BEFORE UPDATE OR DELETE ON "credit_adjustments" FOR EACH ROW EXECUTE FUNCTION finance_guard_credit_adjustment();--> statement-breakpoint
-- Money that came back is a fact: kept as recorded.
CREATE TRIGGER refund_returns_append_only BEFORE UPDATE OR DELETE ON "refund_returns" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- A bank payment file is kept exactly as it was made; only its status and download count move, forward.
CREATE FUNCTION finance_guard_refund_file() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment files cannot be deleted; cancel them' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.content <> OLD.content OR NEW.content_sha256 <> OLD.content_sha256 OR NEW.total <> OLD.total OR NEW.item_count <> OLD.item_count
     OR NEW.format <> OLD.format OR NEW.method_id <> OLD.method_id OR NEW.number <> OLD.number OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'a payment file keeps its content' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'generated' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % payment file cannot change', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER refund_payment_files_guard BEFORE UPDATE OR DELETE ON "refund_payment_files" FOR EACH ROW EXECUTE FUNCTION finance_guard_refund_file();--> statement-breakpoint
CREATE FUNCTION finance_guard_refund_file_item() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment file lines cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.file_id <> OLD.file_id OR NEW.refund_id <> OLD.refund_id OR NEW.amount <> OLD.amount OR NEW.beneficiary <> OLD.beneficiary OR NEW.end_to_end_id <> OLD.end_to_end_id THEN
    RAISE EXCEPTION 'a payment file line keeps what it says' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state <> 'in_file' AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'a payment file line that is % cannot change', OLD.state USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER refund_payment_file_items_guard BEFORE UPDATE OR DELETE ON "refund_payment_file_items" FOR EACH ROW EXECUTE FUNCTION finance_guard_refund_file_item();
