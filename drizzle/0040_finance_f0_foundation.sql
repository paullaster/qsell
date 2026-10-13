CREATE TABLE "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"no" integer NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"status_changed_by" text,
	CONSTRAINT "accounting_periods_dates_chk" CHECK ("accounting_periods"."ends_on" >= "accounting_periods"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "business_posting_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_posting_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"receivables_account_id" uuid,
	"customer_deposits_account_id" uuid,
	"refunds_payable_account_id" uuid,
	"payment_discount_account_id" uuid,
	"write_off_account_id" uuid,
	"rounding_account_id" uuid,
	"fx_gain_account_id" uuid,
	"fx_loss_account_id" uuid,
	"service_charge_account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "finance_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"base_currency" text NOT NULL,
	"chart_template" text,
	"chart_applied_at" timestamp with time zone,
	"posting_from" date,
	"posting_to" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"shape" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_years_dates_chk" CHECK ("fiscal_years"."ends_on" >= "fiscal_years"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "general_posting_setup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"business_group_id" uuid NOT NULL,
	"product_group_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"sales_account_id" uuid,
	"sales_returns_account_id" uuid,
	"sales_discount_account_id" uuid,
	"cogs_account_id" uuid,
	"inventory_adjustment_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gl_account_balances" (
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"dimension_set_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL,
	"shard" smallint NOT NULL,
	"base_debit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"base_credit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"entry_count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "gl_account_balances_company_id_account_id_period_id_dimension_set_id_shard_pk" PRIMARY KEY("company_id","account_id","period_id","dimension_set_id","shard")
);
--> statement-breakpoint
CREATE TABLE "gl_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"no" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"category" text,
	"subcategory" text,
	"normal_balance" text NOT NULL,
	"direct_posting" boolean DEFAULT true NOT NULL,
	"posting_source" text DEFAULT 'manual' NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"currency_policy" text DEFAULT 'any' NOT NULL,
	"dimension_rule" text DEFAULT 'none' NOT NULL,
	"totaling" text,
	"indent" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE SEQUENCE "gl_entries_id_seq" AS bigint;--> statement-breakpoint
CREATE TABLE "gl_entries" (
	"id" bigint DEFAULT nextval('gl_entries_id_seq') NOT NULL,
	"posting_date" date NOT NULL,
	"company_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(20, 4) NOT NULL,
	"credit" numeric(20, 4) NOT NULL,
	"base_debit" numeric(20, 4) NOT NULL,
	"base_credit" numeric(20, 4) NOT NULL,
	"currency" text NOT NULL,
	"description" text,
	"dimension_set_id" uuid,
	"document_type" text NOT NULL,
	"document_no" text NOT NULL,
	"branch_id" uuid,
	"source_ledger" text,
	"source_entry_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gl_entries_id_posting_date_pk" PRIMARY KEY("id","posting_date"),
	CONSTRAINT "gl_entries_one_side_chk" CHECK (("debit" = 0) <> ("credit" = 0))
) PARTITION BY RANGE ("posting_date");
--> statement-breakpoint
CREATE TABLE "journal_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"posting_date" date NOT NULL,
	"document_no" text NOT NULL,
	"account_id" uuid NOT NULL,
	"description" text,
	"debit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"rate" text DEFAULT '1' NOT NULL,
	"dimension_set_id" uuid,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_one_side_chk" CHECK (("journal_lines"."debit" = 0) <> ("journal_lines"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "ledger_register_chains" (
	"company_id" uuid NOT NULL,
	"chain_key" text NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"last_hash" text NOT NULL,
	CONSTRAINT "ledger_register_chains_company_id_chain_key_pk" PRIMARY KEY("company_id","chain_key")
);
--> statement-breakpoint
CREATE TABLE "ledger_registers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chain_key" text NOT NULL,
	"seq" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"document_type" text NOT NULL,
	"document_no" text NOT NULL,
	"description" text,
	"posting_date" date NOT NULL,
	"document_date" date NOT NULL,
	"period_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"rate" text NOT NULL,
	"rate_source" text NOT NULL,
	"total_debit" numeric(20, 4) NOT NULL,
	"total_credit" numeric(20, 4) NOT NULL,
	"base_total_debit" numeric(20, 4) NOT NULL,
	"base_total_credit" numeric(20, 4) NOT NULL,
	"line_count" integer NOT NULL,
	"branch_id" uuid,
	"source_type" text,
	"source_id" text,
	"reversal_of_id" uuid,
	"posted_by_type" text NOT NULL,
	"posted_by_id" text,
	"reason_code" text,
	"reason_text" text,
	"origin" jsonb NOT NULL,
	"previous_hash" text NOT NULL,
	"hash" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_registers_balanced_chk" CHECK ("ledger_registers"."total_debit" = "ledger_registers"."total_credit"),
	CONSTRAINT "ledger_registers_base_balanced_chk" CHECK ("ledger_registers"."base_total_debit" = "ledger_registers"."base_total_credit")
);
--> statement-breakpoint
CREATE TABLE "product_posting_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "register_reversals" (
	"original_id" uuid PRIMARY KEY NOT NULL,
	"reversal_id" uuid NOT NULL,
	"reversed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_fiscal_year_id_fiscal_years_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_posting_groups" ADD CONSTRAINT "business_posting_groups_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_receivables_account_id_gl_accounts_id_fk" FOREIGN KEY ("receivables_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_customer_deposits_account_id_gl_accounts_id_fk" FOREIGN KEY ("customer_deposits_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_refunds_payable_account_id_gl_accounts_id_fk" FOREIGN KEY ("refunds_payable_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_payment_discount_account_id_gl_accounts_id_fk" FOREIGN KEY ("payment_discount_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_write_off_account_id_gl_accounts_id_fk" FOREIGN KEY ("write_off_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_rounding_account_id_gl_accounts_id_fk" FOREIGN KEY ("rounding_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_fx_gain_account_id_gl_accounts_id_fk" FOREIGN KEY ("fx_gain_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_fx_loss_account_id_gl_accounts_id_fk" FOREIGN KEY ("fx_loss_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_service_charge_account_id_gl_accounts_id_fk" FOREIGN KEY ("service_charge_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_business_group_id_business_posting_groups_id_fk" FOREIGN KEY ("business_group_id") REFERENCES "public"."business_posting_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_product_group_id_product_posting_groups_id_fk" FOREIGN KEY ("product_group_id") REFERENCES "public"."product_posting_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_sales_account_id_gl_accounts_id_fk" FOREIGN KEY ("sales_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_sales_returns_account_id_gl_accounts_id_fk" FOREIGN KEY ("sales_returns_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_sales_discount_account_id_gl_accounts_id_fk" FOREIGN KEY ("sales_discount_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_cogs_account_id_gl_accounts_id_fk" FOREIGN KEY ("cogs_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_inventory_adjustment_account_id_gl_accounts_id_fk" FOREIGN KEY ("inventory_adjustment_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gl_accounts" ADD CONSTRAINT "gl_accounts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_batches" ADD CONSTRAINT "journal_batches_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_batch_id_journal_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."journal_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_gl_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_register_chains" ADD CONSTRAINT "ledger_register_chains_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_registers" ADD CONSTRAINT "ledger_registers_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_posting_groups" ADD CONSTRAINT "product_posting_groups_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_reversals" ADD CONSTRAINT "register_reversals_original_id_ledger_registers_id_fk" FOREIGN KEY ("original_id") REFERENCES "public"."ledger_registers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_reversals" ADD CONSTRAINT "register_reversals_reversal_id_ledger_registers_id_fk" FOREIGN KEY ("reversal_id") REFERENCES "public"."ledger_registers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_periods_company_start_uidx" ON "accounting_periods" USING btree ("company_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_periods_year_no_uidx" ON "accounting_periods" USING btree ("fiscal_year_id","no");--> statement-breakpoint
CREATE INDEX "accounting_periods_company_dates_idx" ON "accounting_periods" USING btree ("company_id","starts_on","ends_on");--> statement-breakpoint
CREATE UNIQUE INDEX "business_posting_groups_company_code_uidx" ON "business_posting_groups" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_posting_groups_company_code_uidx" ON "customer_posting_groups" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_years_company_code_uidx" ON "fiscal_years" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_years_company_start_uidx" ON "fiscal_years" USING btree ("company_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "general_posting_setup_uidx" ON "general_posting_setup" USING btree ("business_group_id","product_group_id","effective_from");--> statement-breakpoint
CREATE INDEX "general_posting_setup_company_idx" ON "general_posting_setup" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "gl_account_balances_period_idx" ON "gl_account_balances" USING btree ("company_id","period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gl_accounts_company_no_uidx" ON "gl_accounts" USING btree ("company_id","no");--> statement-breakpoint
CREATE INDEX "gl_accounts_company_type_idx" ON "gl_accounts" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX "gl_entries_account_date_idx" ON "gl_entries" USING btree ("company_id","account_id","posting_date");--> statement-breakpoint
CREATE INDEX "gl_entries_register_idx" ON "gl_entries" USING btree ("register_id");--> statement-breakpoint
CREATE INDEX "gl_entries_document_idx" ON "gl_entries" USING btree ("company_id","document_no");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_batches_company_code_uidx" ON "journal_batches" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "journal_lines_batch_idx" ON "journal_lines" USING btree ("batch_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_registers_idem_uidx" ON "ledger_registers" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_registers_chain_seq_uidx" ON "ledger_registers" USING btree ("company_id","chain_key","seq");--> statement-breakpoint
CREATE INDEX "ledger_registers_company_date_idx" ON "ledger_registers" USING btree ("company_id","posting_date");--> statement-breakpoint
CREATE INDEX "ledger_registers_doc_idx" ON "ledger_registers" USING btree ("company_id","document_no");--> statement-breakpoint
CREATE UNIQUE INDEX "product_posting_groups_company_code_uidx" ON "product_posting_groups" USING btree ("company_id","code");--> statement-breakpoint
ALTER SEQUENCE "gl_entries_id_seq" OWNED BY "gl_entries"."id";--> statement-breakpoint
-- Entries outside every monthly partition land here rather than failing; the monthly job keeps ahead.
CREATE TABLE "gl_entries_default" PARTITION OF "gl_entries" DEFAULT;--> statement-breakpoint
CREATE FUNCTION finance_ensure_gl_partitions(from_month date, to_month date) RETURNS integer AS $$
DECLARE
  m date := date_trunc('month', from_month)::date;
  created integer := 0;
  part text;
BEGIN
  WHILE m <= date_trunc('month', to_month)::date LOOP
    part := 'gl_entries_p' || to_char(m, 'YYYYMM');
    IF to_regclass(part) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF gl_entries FOR VALUES FROM (%L) TO (%L)',
        part, m, (m + interval '1 month')::date);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
SELECT finance_ensure_gl_partitions('2025-01-01', '2031-12-01');--> statement-breakpoint
-- The books are facts: the database itself refuses to change or delete a posted row.
CREATE TRIGGER gl_entries_append_only BEFORE UPDATE OR DELETE ON "gl_entries" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER ledger_registers_append_only BEFORE UPDATE OR DELETE ON "ledger_registers" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER register_reversals_append_only BEFORE UPDATE OR DELETE ON "register_reversals" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- Once an account has been posted to, what it is cannot change and it cannot be deleted.
CREATE FUNCTION finance_guard_used_account() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.used_at IS NOT NULL THEN
      RAISE EXCEPTION 'account % has postings and cannot be deleted; block it instead', OLD.no USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.used_at IS NOT NULL AND (NEW.no <> OLD.no OR NEW.type <> OLD.type OR NEW.currency_policy <> OLD.currency_policy OR NEW.normal_balance <> OLD.normal_balance) THEN
    RAISE EXCEPTION 'account % has postings: its number, type, normal balance and currency cannot change', OLD.no USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER gl_accounts_guard_used BEFORE UPDATE OR DELETE ON "gl_accounts" FOR EACH ROW EXECUTE FUNCTION finance_guard_used_account();
