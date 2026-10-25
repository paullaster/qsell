CREATE TABLE "vendor_detailed_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_detailed_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"applied_to_entry_id" uuid,
	"application_id" uuid,
	"unapplies_application_id" uuid,
	"posting_date" date NOT NULL,
	"register_id" uuid,
	"reason_code" text,
	"reason_text" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"vendor_id" uuid NOT NULL,
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
CREATE TABLE "vendor_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"document_no" text NOT NULL,
	"external_document_no" text,
	"description" text,
	"amount" numeric(14, 2) NOT NULL,
	"remaining_amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"posting_date" date NOT NULL,
	"document_date" date,
	"due_date" date,
	"document_id" uuid,
	"register_id" uuid,
	"idempotency_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_ledger_type_chk" CHECK ("vendor_ledger_entries"."document_type" IN ('invoice','credit_memo','payment','advance','refund'))
);
--> statement-breakpoint
CREATE TABLE "vendor_posting_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"payables_account_id" uuid,
	"prepayments_account_id" uuid,
	"payment_discount_account_id" uuid,
	"payment_tolerance_account_id" uuid,
	"fx_gain_account_id" uuid,
	"fx_loss_account_id" uuid,
	"withholding_payable_account_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_posting_groups_code_chk" CHECK ("vendor_posting_groups"."code" ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$')
);
--> statement-breakpoint
CREATE TABLE "vendor_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"portal_role" text DEFAULT 'owner' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_users_role_chk" CHECK ("vendor_users"."portal_role" IN ('owner','finance','sales','readonly')),
	CONSTRAINT "vendor_users_status_chk" CHECK ("vendor_users"."status" IN ('active','removed'))
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'registered' NOT NULL,
	"block" text DEFAULT 'none' NOT NULL,
	"vendor_type" text DEFAULT 'company' NOT NULL,
	"legal_name" text NOT NULL,
	"trading_name" text,
	"tax_id" text,
	"vat_no" text,
	"registration_no" text,
	"country" text,
	"email" text NOT NULL,
	"phone" text,
	"customer_id" uuid,
	"posting_group_id" uuid,
	"payment_term_days" integer DEFAULT 30 NOT NULL,
	"currency" text,
	"approved_expense_vendor" boolean DEFAULT false NOT NULL,
	"created_by_staff" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_status_chk" CHECK ("vendors"."status" IN ('registered','profile_in_progress','profile_submitted','under_review','revision_requested','active','rejected','suspended','archived')),
	CONSTRAINT "vendors_block_chk" CHECK ("vendors"."block" IN ('none','payment','all')),
	CONSTRAINT "vendors_legal_name_chk" CHECK (char_length(btrim("vendors"."legal_name")) BETWEEN 1 AND 200),
	CONSTRAINT "vendors_active_numbered_chk" CHECK ("vendors"."status" <> 'active' OR "vendors"."number" IS NOT NULL),
	CONSTRAINT "vendors_term_chk" CHECK ("vendors"."payment_term_days" BETWEEN 0 AND 365)
);
--> statement-breakpoint
ALTER TABLE "vendor_detailed_entries" ADD CONSTRAINT "vendor_detailed_entries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_detailed_entries" ADD CONSTRAINT "vendor_detailed_entries_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_detailed_entries" ADD CONSTRAINT "vendor_detailed_entries_ledger_entry_id_vendor_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."vendor_ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_events" ADD CONSTRAINT "vendor_events_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_ledger_entries" ADD CONSTRAINT "vendor_ledger_entries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_ledger_entries" ADD CONSTRAINT "vendor_ledger_entries_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_posting_groups" ADD CONSTRAINT "vendor_posting_groups_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_posting_groups" ADD CONSTRAINT "vendor_posting_groups_payables_account_id_gl_accounts_id_fk" FOREIGN KEY ("payables_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_posting_groups" ADD CONSTRAINT "vendor_posting_groups_prepayments_account_id_gl_accounts_id_fk" FOREIGN KEY ("prepayments_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_posting_groups" ADD CONSTRAINT "vendor_posting_groups_payment_discount_account_id_gl_accounts_id_fk" FOREIGN KEY ("payment_discount_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_posting_groups" ADD CONSTRAINT "vendor_posting_groups_payment_tolerance_account_id_gl_accounts_id_fk" FOREIGN KEY ("payment_tolerance_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_posting_groups" ADD CONSTRAINT "vendor_posting_groups_fx_gain_account_id_gl_accounts_id_fk" FOREIGN KEY ("fx_gain_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_posting_groups" ADD CONSTRAINT "vendor_posting_groups_fx_loss_account_id_gl_accounts_id_fk" FOREIGN KEY ("fx_loss_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_posting_groups" ADD CONSTRAINT "vendor_posting_groups_withholding_payable_account_id_gl_accounts_id_fk" FOREIGN KEY ("withholding_payable_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_posting_group_id_vendor_posting_groups_id_fk" FOREIGN KEY ("posting_group_id") REFERENCES "public"."vendor_posting_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_detailed_entry_idx" ON "vendor_detailed_entries" USING btree ("ledger_entry_id");--> statement-breakpoint
CREATE INDEX "vendor_detailed_vendor_idx" ON "vendor_detailed_entries" USING btree ("vendor_id","id");--> statement-breakpoint
CREATE INDEX "vendor_detailed_application_idx" ON "vendor_detailed_entries" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_detailed_unapply_once_uidx" ON "vendor_detailed_entries" USING btree ("unapplies_application_id","ledger_entry_id","applied_to_entry_id") WHERE "vendor_detailed_entries"."unapplies_application_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vendor_events_vendor_idx" ON "vendor_events" USING btree ("vendor_id","id");--> statement-breakpoint
CREATE INDEX "vendor_ledger_vendor_idx" ON "vendor_ledger_entries" USING btree ("vendor_id","posting_date");--> statement-breakpoint
CREATE INDEX "vendor_ledger_document_idx" ON "vendor_ledger_entries" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "vendor_ledger_open_due_idx" ON "vendor_ledger_entries" USING btree ("due_date") WHERE "vendor_ledger_entries"."remaining_amount" <> 0;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_ledger_idem_uidx" ON "vendor_ledger_entries" USING btree ("company_id","idempotency_key") WHERE "vendor_ledger_entries"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_ledger_external_no_uidx" ON "vendor_ledger_entries" USING btree ("vendor_id",lower(btrim("external_document_no"))) WHERE "vendor_ledger_entries"."external_document_no" IS NOT NULL AND "vendor_ledger_entries"."document_type" = 'invoice';--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_posting_groups_company_code_uidx" ON "vendor_posting_groups" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_users_user_uidx" ON "vendor_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "vendor_users_vendor_idx" ON "vendor_users" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_users_one_owner_uidx" ON "vendor_users" USING btree ("vendor_id") WHERE "vendor_users"."portal_role" = 'owner' AND "vendor_users"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_company_number_uidx" ON "vendors" USING btree ("company_id","number") WHERE "vendors"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_company_tax_id_uidx" ON "vendors" USING btree ("company_id",lower("tax_id")) WHERE "vendors"."tax_id" IS NOT NULL AND "vendors"."status" <> 'archived';--> statement-breakpoint
CREATE INDEX "vendors_company_status_idx" ON "vendors" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "vendors_company_email_idx" ON "vendors" USING btree ("company_id",lower("email"));--> statement-breakpoint
-- The vendor ledger is a record: apart from what is still open (remaining amount), a posted entry cannot change, and none can be deleted.
CREATE FUNCTION finance_guard_vendor_ledger() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vendor ledger entries cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id
     OR NEW.vendor_id <> OLD.vendor_id
     OR NEW.document_type <> OLD.document_type
     OR NEW.document_no <> OLD.document_no
     OR NEW.external_document_no IS DISTINCT FROM OLD.external_document_no
     OR NEW.amount <> OLD.amount
     OR NEW.currency <> OLD.currency
     OR NEW.posting_date <> OLD.posting_date
     OR NEW.document_date IS DISTINCT FROM OLD.document_date
     OR NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR (OLD.register_id IS NOT NULL AND NEW.register_id IS DISTINCT FROM OLD.register_id) THEN
    RAISE EXCEPTION 'a posted vendor ledger entry cannot be changed; apply or reverse it instead' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_ledger_guard BEFORE UPDATE OR DELETE ON "vendor_ledger_entries" FOR EACH ROW EXECUTE FUNCTION finance_guard_vendor_ledger();--> statement-breakpoint
CREATE TRIGGER vendor_detailed_append_only BEFORE UPDATE OR DELETE ON "vendor_detailed_entries" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER vendor_events_append_only BEFORE UPDATE OR DELETE ON "vendor_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();
