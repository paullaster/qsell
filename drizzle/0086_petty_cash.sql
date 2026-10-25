CREATE TABLE "petty_cash_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "petty_cash_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"event" text NOT NULL,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "petty_cash_floats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"custodian_id" text NOT NULL,
	"currency" text NOT NULL,
	"float_amount" numeric(14, 2) NOT NULL,
	"per_voucher_limit" numeric(14, 2) NOT NULL,
	"daily_limit" numeric(14, 2) NOT NULL,
	"minimum_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "petty_cash_floats_limits_chk" CHECK ("petty_cash_floats"."float_amount" > 0 AND "petty_cash_floats"."per_voucher_limit" > 0 AND "petty_cash_floats"."daily_limit" >= "petty_cash_floats"."per_voucher_limit" AND "petty_cash_floats"."minimum_balance" >= 0 AND "petty_cash_floats"."minimum_balance" <= "petty_cash_floats"."float_amount")
);
--> statement-breakpoint
CREATE TABLE "petty_cash_replenishments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"float_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"from_method_id" uuid NOT NULL,
	"count_note" text,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"paid_by" text,
	"paid_at" timestamp with time zone,
	"paid_on" date,
	"reference" text,
	"register_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "petty_cash_replenishments_status_chk" CHECK ("petty_cash_replenishments"."status" IN ('pending_approval','approved','paid','cancelled')),
	CONSTRAINT "petty_cash_replenishments_amount_chk" CHECK ("petty_cash_replenishments"."amount" > 0),
	CONSTRAINT "petty_cash_replenishments_approver_chk" CHECK ("petty_cash_replenishments"."approved_by" IS NULL OR "petty_cash_replenishments"."approved_by" IS DISTINCT FROM "petty_cash_replenishments"."created_by"),
	CONSTRAINT "petty_cash_replenishments_paid_chk" CHECK ("petty_cash_replenishments"."status" <> 'paid' OR ("petty_cash_replenishments"."register_id" IS NOT NULL AND "petty_cash_replenishments"."paid_by" IS NOT NULL AND "petty_cash_replenishments"."reference" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "petty_cash_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"float_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"kind" text NOT NULL,
	"payee_name" text NOT NULL,
	"vendor_id" uuid,
	"purchase_invoice_id" uuid,
	"expense_account_id" uuid,
	"description" text NOT NULL,
	"receipt_ref" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"created_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"send_back_reason" text,
	"paid_by" text,
	"paid_at" timestamp with time zone,
	"paid_on" date,
	"register_id" uuid,
	"bank_ledger_entry_id" bigint,
	"ledger_entry_id" uuid,
	"replenishment_id" uuid,
	"cancel_reason" text,
	"reversed_by" text,
	"reversed_at" timestamp with time zone,
	"reverse_reason" text,
	"reversal_register_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "petty_cash_vouchers_status_chk" CHECK ("petty_cash_vouchers"."status" IN ('draft','pending_approval','approved','paid','cancelled','reversed')),
	CONSTRAINT "petty_cash_vouchers_amount_chk" CHECK ("petty_cash_vouchers"."amount" > 0),
	CONSTRAINT "petty_cash_vouchers_kind_chk" CHECK (("petty_cash_vouchers"."kind" = 'vendor_invoice') = ("petty_cash_vouchers"."purchase_invoice_id" IS NOT NULL) AND ("petty_cash_vouchers"."kind" = 'vendor_invoice' OR "petty_cash_vouchers"."expense_account_id" IS NOT NULL)),
	CONSTRAINT "petty_cash_vouchers_approver_chk" CHECK ("petty_cash_vouchers"."approved_by" IS NULL OR "petty_cash_vouchers"."approved_by" IS DISTINCT FROM "petty_cash_vouchers"."created_by"),
	CONSTRAINT "petty_cash_vouchers_paid_chk" CHECK ("petty_cash_vouchers"."status" NOT IN ('paid','reversed') OR ("petty_cash_vouchers"."register_id" IS NOT NULL AND "petty_cash_vouchers"."paid_by" IS NOT NULL AND "petty_cash_vouchers"."paid_on" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "petty_cash_events" ADD CONSTRAINT "petty_cash_events_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_floats" ADD CONSTRAINT "petty_cash_floats_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_floats" ADD CONSTRAINT "petty_cash_floats_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_floats" ADD CONSTRAINT "petty_cash_floats_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_replenishments" ADD CONSTRAINT "petty_cash_replenishments_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_replenishments" ADD CONSTRAINT "petty_cash_replenishments_float_id_petty_cash_floats_id_fk" FOREIGN KEY ("float_id") REFERENCES "public"."petty_cash_floats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_replenishments" ADD CONSTRAINT "petty_cash_replenishments_from_method_id_payment_methods_id_fk" FOREIGN KEY ("from_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_float_id_petty_cash_floats_id_fk" FOREIGN KEY ("float_id") REFERENCES "public"."petty_cash_floats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_purchase_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_expense_account_id_gl_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "petty_cash_events_idx" ON "petty_cash_events" USING btree ("subject_type","subject_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_floats_code_uidx" ON "petty_cash_floats" USING btree ("company_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_floats_bank_uidx" ON "petty_cash_floats" USING btree ("bank_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_replenishments_number_uidx" ON "petty_cash_replenishments" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "petty_cash_replenishments_float_idx" ON "petty_cash_replenishments" USING btree ("float_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_vouchers_number_uidx" ON "petty_cash_vouchers" USING btree ("company_id","number") WHERE "petty_cash_vouchers"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "petty_cash_vouchers_float_idx" ON "petty_cash_vouchers" USING btree ("float_id","status","created_at");--> statement-breakpoint
CREATE INDEX "petty_cash_vouchers_paid_idx" ON "petty_cash_vouchers" USING btree ("float_id","paid_on") WHERE "petty_cash_vouchers"."status" = 'paid';--> statement-breakpoint
CREATE INDEX "petty_cash_vouchers_invoice_idx" ON "petty_cash_vouchers" USING btree ("purchase_invoice_id") WHERE "petty_cash_vouchers"."purchase_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER petty_cash_events_append_only BEFORE UPDATE OR DELETE ON "petty_cash_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- A voucher that has paid out cash is a record of it: only its own reversal may change it, and it is never deleted.
CREATE FUNCTION petty_cash_voucher_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'a petty cash voucher that has gone further than a draft cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('paid', 'reversed', 'cancelled') AND (NEW.float_id <> OLD.float_id OR NEW.amount <> OLD.amount OR NEW.kind <> OLD.kind OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.payee_name <> OLD.payee_name OR NEW.expense_account_id IS DISTINCT FROM OLD.expense_account_id OR NEW.purchase_invoice_id IS DISTINCT FROM OLD.purchase_invoice_id) THEN
    RAISE EXCEPTION 'a paid petty cash voucher cannot be changed; reverse it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('reversed', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'this petty cash voucher is finished' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'paid' AND NEW.status NOT IN ('paid', 'reversed') THEN
    RAISE EXCEPTION 'a paid petty cash voucher can only be reversed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER petty_cash_vouchers_guard BEFORE UPDATE OR DELETE ON "petty_cash_vouchers" FOR EACH ROW EXECUTE FUNCTION petty_cash_voucher_guard();--> statement-breakpoint
CREATE FUNCTION petty_cash_replenishment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a replenishment cannot be deleted; cancel it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('paid', 'cancelled') AND (NEW.amount <> OLD.amount OR NEW.float_id <> OLD.float_id OR NEW.from_method_id <> OLD.from_method_id OR NEW.number <> OLD.number OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'a finished replenishment cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER petty_cash_replenishments_guard BEFORE UPDATE OR DELETE ON "petty_cash_replenishments" FOR EACH ROW EXECUTE FUNCTION petty_cash_replenishment_guard();
