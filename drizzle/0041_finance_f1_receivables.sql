CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"currency" text NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"fee_gl_account_id" uuid,
	"branch_id" uuid,
	"provider_config_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"statement_format" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"document_type" text NOT NULL,
	"document_no" text NOT NULL,
	"document_id" uuid,
	"description" text,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text NOT NULL,
	"register_id" uuid,
	"reverses_entry_id" bigint,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_detailed_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_detailed_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"applied_to_entry_id" uuid,
	"application_id" uuid,
	"unapplies_application_id" uuid,
	"posting_date" date,
	"register_id" uuid,
	"reason_code" text,
	"reason_text" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"rate" text DEFAULT '1' NOT NULL,
	"payment_date" date NOT NULL,
	"posting_date" date NOT NULL,
	"external_reference" text,
	"payer_name" text,
	"counterparty" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"narration" text,
	"branch_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"cheque_status" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"order_id" text,
	"idempotency_key" text,
	"ledger_entry_id" uuid,
	"register_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_receipts_amount_chk" CHECK ("customer_receipts"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "finance_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"media_asset_id" text NOT NULL,
	"file_name" text NOT NULL,
	"note" text,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"balancing_bank_account_id" uuid NOT NULL,
	"requires_reference" boolean DEFAULT false NOT NULL,
	"requires_evidence" boolean DEFAULT false NOT NULL,
	"requires_counterparty" boolean DEFAULT false NOT NULL,
	"collect_provider_config_id" uuid,
	"payout_provider_config_id" uuid,
	"usable_for" jsonb DEFAULT '["customer_receipt"]'::jsonb NOT NULL,
	"settlement_mode" text DEFAULT 'immediate' NOT NULL,
	"settlement_days" integer DEFAULT 0 NOT NULL,
	"fee_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refund_destination" text DEFAULT 'none' NOT NULL,
	"legacy_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "receipt_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"receipt_id" uuid NOT NULL,
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
ALTER TABLE "customer_ledger_entries" ADD COLUMN "posting_date" date;--> statement-breakpoint
ALTER TABLE "customer_ledger_entries" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "customer_ledger_entries" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_ledger_entries" ADD COLUMN "register_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "posting_group_code" text;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD COLUMN "sales_gl_go_live" date;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD COLUMN "default_customer_group" text DEFAULT 'DOMESTIC' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD COLUMN "last_test_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD COLUMN "last_test_ok" boolean;--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD COLUMN "last_test_message" text;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_fee_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("fee_gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_provider_config_id_payment_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_ledger_entries" ADD CONSTRAINT "bank_ledger_entries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_ledger_entries" ADD CONSTRAINT "bank_ledger_entries_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_detailed_entries" ADD CONSTRAINT "customer_detailed_entries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_detailed_entries" ADD CONSTRAINT "customer_detailed_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_detailed_entries" ADD CONSTRAINT "customer_detailed_entries_ledger_entry_id_customer_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."customer_ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_attachments" ADD CONSTRAINT "finance_attachments_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_balancing_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("balancing_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_collect_provider_config_id_payment_provider_configs_id_fk" FOREIGN KEY ("collect_provider_config_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_payout_provider_config_id_payment_provider_configs_id_fk" FOREIGN KEY ("payout_provider_config_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_events" ADD CONSTRAINT "receipt_events_receipt_id_customer_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."customer_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_company_code_uidx" ON "bank_accounts" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "bank_accounts_gl_idx" ON "bank_accounts" USING btree ("gl_account_id");--> statement-breakpoint
CREATE INDEX "bank_ledger_account_date_idx" ON "bank_ledger_entries" USING btree ("bank_account_id","posting_date");--> statement-breakpoint
CREATE INDEX "bank_ledger_document_idx" ON "bank_ledger_entries" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "customer_detailed_entry_idx" ON "customer_detailed_entries" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "customer_detailed_customer_idx" ON "customer_detailed_entries" USING btree ("customer_id","id");--> statement-breakpoint
CREATE INDEX "customer_detailed_application_idx" ON "customer_detailed_entries" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_detailed_unapply_once_uidx" ON "customer_detailed_entries" USING btree ("unapplies_application_id","ledger_entry_id","applied_to_entry_id") WHERE "customer_detailed_entries"."unapplies_application_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_receipts_company_number_uidx" ON "customer_receipts" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_receipts_idem_uidx" ON "customer_receipts" USING btree ("company_id","idempotency_key") WHERE "customer_receipts"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_receipts_reference_uidx" ON "customer_receipts" USING btree ("company_id","payment_method_id","external_reference") WHERE "customer_receipts"."external_reference" IS NOT NULL AND "customer_receipts"."status" IN ('draft','posted');--> statement-breakpoint
CREATE INDEX "customer_receipts_customer_idx" ON "customer_receipts" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_receipts_status_idx" ON "customer_receipts" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "finance_attachments_subject_idx" ON "finance_attachments" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_company_code_uidx" ON "payment_methods" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "payment_methods_bank_idx" ON "payment_methods" USING btree ("balancing_bank_account_id");--> statement-breakpoint
CREATE INDEX "receipt_events_receipt_idx" ON "receipt_events" USING btree ("receipt_id","id");--> statement-breakpoint
CREATE INDEX "customer_ledger_document_idx" ON "customer_ledger_entries" USING btree ("document_id");--> statement-breakpoint
-- ─── Receivables: give the existing customer ledger its detailed entries (before the guard) ───
UPDATE "customer_ledger_entries" SET
  "posting_date" = ("created_at" AT TIME ZONE 'Africa/Nairobi')::date
WHERE "posting_date" IS NULL;--> statement-breakpoint
UPDATE "customer_ledger_entries" e SET
  "currency" = COALESCE((SELECT o."currency" FROM "orders" o WHERE o."id" = e."order_id"), 'KES')
WHERE e."currency" IS NULL;--> statement-breakpoint
-- What each entry was when it was posted...
INSERT INTO "customer_detailed_entries" ("company_id","customer_id","ledger_entry_id","entry_type","amount","posting_date","reason_text","created_at")
SELECT "company_id","customer_id","id",'initial',"amount","posting_date",'Opening position from before detailed tracking',"created_at"
FROM "customer_ledger_entries";--> statement-breakpoint
-- ...and everything that had already been settled against it, so the sum equals what is open today.
INSERT INTO "customer_detailed_entries" ("company_id","customer_id","ledger_entry_id","entry_type","amount","posting_date","reason_text","created_at")
SELECT "company_id","customer_id","id",'application',("remaining_amount" - "amount"),"posting_date",'Settled before detailed tracking',"created_at"
FROM "customer_ledger_entries"
WHERE "remaining_amount" <> "amount";--> statement-breakpoint
-- The ledger is a record: apart from what is still open (remaining amount) and the tax-signing status,
-- a posted entry cannot change, and none can be deleted.
CREATE FUNCTION finance_guard_customer_ledger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer ledger entries cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id
     OR NEW.customer_id <> OLD.customer_id
     OR NEW.document_type <> OLD.document_type
     OR NEW.document_no <> OLD.document_no
     OR NEW.amount <> OLD.amount
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR (OLD.posting_date IS NOT NULL AND NEW.posting_date IS DISTINCT FROM OLD.posting_date)
     OR (OLD.currency IS NOT NULL AND NEW.currency IS DISTINCT FROM OLD.currency)
     OR (OLD.register_id IS NOT NULL AND NEW.register_id IS DISTINCT FROM OLD.register_id) THEN
    RAISE EXCEPTION 'a posted customer ledger entry cannot be changed; apply or reverse it instead' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER customer_ledger_guard BEFORE UPDATE OR DELETE ON "customer_ledger_entries" FOR EACH ROW EXECUTE FUNCTION finance_guard_customer_ledger();--> statement-breakpoint
CREATE TRIGGER customer_detailed_append_only BEFORE UPDATE OR DELETE ON "customer_detailed_entries" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER bank_ledger_append_only BEFORE UPDATE OR DELETE ON "bank_ledger_entries" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER receipt_events_append_only BEFORE UPDATE OR DELETE ON "receipt_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- A receipt, once posted, keeps its money facts: only its status, cheque status and links may move.
CREATE FUNCTION finance_guard_receipt() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipts cannot be deleted; cancel or reverse them' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.customer_id <> OLD.customer_id OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
       OR NEW.payment_method_id <> OLD.payment_method_id OR NEW.number <> OLD.number
       OR NEW.posting_date <> OLD.posting_date OR NEW.payment_date <> OLD.payment_date
       OR NEW.external_reference IS DISTINCT FROM OLD.external_reference) THEN
    RAISE EXCEPTION 'a posted receipt cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('reversed','cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % receipt cannot change status again', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER customer_receipts_guard BEFORE UPDATE OR DELETE ON "customer_receipts" FOR EACH ROW EXECUTE FUNCTION finance_guard_receipt();--> statement-breakpoint
-- The older gateway table is retired: its sealed credentials move to the provider table (default
-- branch) when that row has none yet. Nothing is switched on by this: a person enables a provider
-- after checking it with "Test connection". The old table stays until a later cleanup.
UPDATE "payment_provider_configs" p SET
  "credentials_encrypted" = g."credentials_encrypted",
  "updated_at" = now()
FROM "payment_gateway_configs" g, "branches" b
WHERE b."id" = p."branch_id" AND b."is_default" = true
  AND p."credentials_encrypted" IS NULL AND g."credentials_encrypted" IS NOT NULL
  AND ((g."id" = 'gw_mpesa_daraja' AND p."provider_code" = 'mpesa_daraja')
    OR (g."id" = 'gw_pesapal_v3' AND p."provider_code" = 'pesapal_v3'));
