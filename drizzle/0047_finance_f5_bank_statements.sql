CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"number" text NOT NULL,
	"statement_date" date NOT NULL,
	"opening_balance" numeric(20, 4) NOT NULL,
	"statement_balance" numeric(20, 4) NOT NULL,
	"lines_total" numeric(20, 4) NOT NULL,
	"line_count" integer NOT NULL,
	"ignored_total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"notes" text,
	"status" text DEFAULT 'posted' NOT NULL,
	"posted_by" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reversed_by" text,
	"reversed_at" timestamp with time zone,
	"reverse_reason_code" text,
	"reverse_reason_text" text
);
--> statement-breakpoint
CREATE TABLE "bank_statement_formats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"format" text NOT NULL,
	"line_count" integer NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"total_in" numeric(20, 4) NOT NULL,
	"total_out" numeric(20, 4) NOT NULL,
	"date_from" date,
	"date_to" date,
	"opening_balance" numeric(20, 4),
	"closing_balance" numeric(20, 4),
	"imported_by" text NOT NULL,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_statement_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"line_date" date NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"reference" text,
	"counterparty" text,
	"amount" numeric(20, 4) NOT NULL,
	"balance" numeric(20, 4),
	"line_hash" text NOT NULL,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"proposed_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"match_rule" text,
	"ignore_reason" text,
	"reconciliation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statement_matches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bank_statement_matches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"line_id" bigint NOT NULL,
	"bank_entry_id" bigint NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"rule" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" text,
	"undo_reason_code" text,
	"undo_reason_text" text
);
--> statement-breakpoint
ALTER TABLE "refund_requests" ADD COLUMN "bank_matched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_formats" ADD CONSTRAINT "bank_statement_formats_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_formats" ADD CONSTRAINT "bank_statement_formats_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_import_id_bank_statement_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."bank_statement_imports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_matches" ADD CONSTRAINT "bank_statement_matches_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_matches" ADD CONSTRAINT "bank_statement_matches_line_id_bank_statement_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_matches" ADD CONSTRAINT "bank_statement_matches_bank_entry_id_bank_ledger_entries_id_fk" FOREIGN KEY ("bank_entry_id") REFERENCES "public"."bank_ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliations_number_uidx" ON "bank_reconciliations" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "bank_reconciliations_account_idx" ON "bank_reconciliations" USING btree ("bank_account_id","statement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_formats_account_uidx" ON "bank_statement_formats" USING btree ("bank_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_imports_file_uidx" ON "bank_statement_imports" USING btree ("bank_account_id","file_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_lines_hash_uidx" ON "bank_statement_lines" USING btree ("bank_account_id","line_hash");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_work_idx" ON "bank_statement_lines" USING btree ("bank_account_id","status","line_date");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_import_idx" ON "bank_statement_lines" USING btree ("import_id","line_no");--> statement-breakpoint
CREATE INDEX "bank_statement_matches_line_idx" ON "bank_statement_matches" USING btree ("line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_matches_entry_open_uidx" ON "bank_statement_matches" USING btree ("bank_entry_id") WHERE "bank_statement_matches"."undone_at" IS NULL;--> statement-breakpoint
-- What the bank said is a fact: imports never change, lines keep what they say, matches are undone not deleted.
CREATE TRIGGER bank_statement_imports_append_only BEFORE UPDATE OR DELETE ON "bank_statement_imports" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE FUNCTION finance_guard_statement_line() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank statement lines cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.line_date <> OLD.line_date OR NEW.amount <> OLD.amount OR NEW.description <> OLD.description
     OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.line_hash <> OLD.line_hash
     OR NEW.import_id <> OLD.import_id OR NEW.bank_account_id <> OLD.bank_account_id OR NEW.line_no <> OLD.line_no THEN
    RAISE EXCEPTION 'a bank statement line keeps what the bank said' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Once reconciled, how it was dealt with is fixed until the reconciliation itself is reversed.
  IF OLD.reconciliation_id IS NOT NULL AND NEW.reconciliation_id IS NOT NULL
     AND (NEW.status <> OLD.status OR NEW.reconciliation_id <> OLD.reconciliation_id) THEN
    RAISE EXCEPTION 'a reconciled bank statement line cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER bank_statement_lines_guard BEFORE UPDATE OR DELETE ON "bank_statement_lines" FOR EACH ROW EXECUTE FUNCTION finance_guard_statement_line();--> statement-breakpoint
CREATE FUNCTION finance_guard_statement_match() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank statement matches are undone, not deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.line_id <> OLD.line_id OR NEW.bank_entry_id <> OLD.bank_entry_id OR NEW.amount <> OLD.amount OR NEW.rule <> OLD.rule THEN
    RAISE EXCEPTION 'a bank statement match cannot be edited, only undone' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'an undone match cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER bank_statement_matches_guard BEFORE UPDATE OR DELETE ON "bank_statement_matches" FOR EACH ROW EXECUTE FUNCTION finance_guard_statement_match();--> statement-breakpoint
CREATE FUNCTION finance_guard_bank_reconciliation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank reconciliations cannot be deleted; reverse the latest one' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.bank_account_id <> OLD.bank_account_id OR NEW.statement_date <> OLD.statement_date OR NEW.statement_balance <> OLD.statement_balance
     OR NEW.opening_balance <> OLD.opening_balance OR NEW.lines_total <> OLD.lines_total OR NEW.number <> OLD.number THEN
    RAISE EXCEPTION 'a posted bank reconciliation cannot be edited' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'reversed' THEN
    RAISE EXCEPTION 'a reversed bank reconciliation cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER bank_reconciliations_guard BEFORE UPDATE OR DELETE ON "bank_reconciliations" FOR EACH ROW EXECUTE FUNCTION finance_guard_bank_reconciliation();
