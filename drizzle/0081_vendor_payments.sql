CREATE TABLE "vendor_payment_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_payment_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"voucher_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_payment_voucher_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"purchase_invoice_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	CONSTRAINT "vendor_payment_voucher_lines_amount_chk" CHECK ("vendor_payment_voucher_lines"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "vendor_payment_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"vendor_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"method_id" uuid NOT NULL,
	"advance_id" uuid,
	"narration" text,
	"vendor_bank_account_id" uuid,
	"destination" text,
	"created_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"needs_three" boolean DEFAULT false NOT NULL,
	"send_back_reason" text,
	"cancel_reason" text,
	"paid_by" text,
	"paid_at" timestamp with time zone,
	"paid_on" date,
	"payment_reference" text,
	"register_id" uuid,
	"ledger_entry_id" uuid,
	"reversed_by" text,
	"reversed_at" timestamp with time zone,
	"reverse_reason" text,
	"reversal_register_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_payment_vouchers_status_chk" CHECK ("vendor_payment_vouchers"."status" IN ('draft','pending_approval','approved','paid','reversed','cancelled')),
	CONSTRAINT "vendor_payment_vouchers_amount_chk" CHECK ("vendor_payment_vouchers"."amount" > 0),
	CONSTRAINT "vendor_payment_vouchers_advance_chk" CHECK (("vendor_payment_vouchers"."kind" = 'advance') = ("vendor_payment_vouchers"."advance_id" IS NOT NULL)),
	CONSTRAINT "vendor_payment_vouchers_approver_chk" CHECK ("vendor_payment_vouchers"."approved_by" IS NULL OR "vendor_payment_vouchers"."approved_by" IS DISTINCT FROM "vendor_payment_vouchers"."created_by"),
	CONSTRAINT "vendor_payment_vouchers_payer_chk" CHECK (NOT "vendor_payment_vouchers"."needs_three" OR "vendor_payment_vouchers"."paid_by" IS NULL OR ("vendor_payment_vouchers"."paid_by" IS DISTINCT FROM "vendor_payment_vouchers"."created_by" AND "vendor_payment_vouchers"."paid_by" IS DISTINCT FROM "vendor_payment_vouchers"."approved_by")),
	CONSTRAINT "vendor_payment_vouchers_paid_chk" CHECK ("vendor_payment_vouchers"."status" NOT IN ('paid','reversed') OR ("vendor_payment_vouchers"."register_id" IS NOT NULL AND "vendor_payment_vouchers"."ledger_entry_id" IS NOT NULL AND "vendor_payment_vouchers"."paid_by" IS NOT NULL AND "vendor_payment_vouchers"."payment_reference" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "payment_three_eyes_above" numeric(14, 2) DEFAULT '100000' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_events" ADD CONSTRAINT "vendor_payment_events_voucher_id_vendor_payment_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vendor_payment_vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_voucher_lines" ADD CONSTRAINT "vendor_payment_voucher_lines_voucher_id_vendor_payment_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vendor_payment_vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_voucher_lines" ADD CONSTRAINT "vendor_payment_voucher_lines_purchase_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD CONSTRAINT "vendor_payment_vouchers_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD CONSTRAINT "vendor_payment_vouchers_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD CONSTRAINT "vendor_payment_vouchers_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD CONSTRAINT "vendor_payment_vouchers_advance_id_vendor_advance_payments_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."vendor_advance_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD CONSTRAINT "vendor_payment_vouchers_vendor_bank_account_id_vendor_bank_accounts_id_fk" FOREIGN KEY ("vendor_bank_account_id") REFERENCES "public"."vendor_bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_payment_events_idx" ON "vendor_payment_events" USING btree ("voucher_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_payment_voucher_lines_uidx" ON "vendor_payment_voucher_lines" USING btree ("voucher_id","purchase_invoice_id");--> statement-breakpoint
CREATE INDEX "vendor_payment_voucher_lines_invoice_idx" ON "vendor_payment_voucher_lines" USING btree ("purchase_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_payment_vouchers_number_uidx" ON "vendor_payment_vouchers" USING btree ("company_id","number") WHERE "vendor_payment_vouchers"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_payment_vouchers_advance_uidx" ON "vendor_payment_vouchers" USING btree ("advance_id") WHERE "vendor_payment_vouchers"."advance_id" IS NOT NULL AND "vendor_payment_vouchers"."status" IN ('draft','pending_approval','approved','paid');--> statement-breakpoint
CREATE INDEX "vendor_payment_vouchers_company_idx" ON "vendor_payment_vouchers" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "vendor_payment_vouchers_vendor_idx" ON "vendor_payment_vouchers" USING btree ("vendor_id","created_at");--> statement-breakpoint
-- A paid voucher is a record of money that left. Only its own reversal may change it, and its history is never rewritten.
CREATE TRIGGER vendor_payment_events_append_only BEFORE UPDATE OR DELETE ON "vendor_payment_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE FUNCTION vendor_payment_voucher_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'a payment voucher that has gone further than a draft cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('paid', 'reversed', 'cancelled') AND (NEW.vendor_id <> OLD.vendor_id OR NEW.amount <> OLD.amount OR NEW.method_id <> OLD.method_id
     OR NEW.kind <> OLD.kind OR NEW.number IS DISTINCT FROM OLD.number OR NEW.currency <> OLD.currency OR NEW.advance_id IS DISTINCT FROM OLD.advance_id
     OR NEW.vendor_bank_account_id IS DISTINCT FROM OLD.vendor_bank_account_id) THEN
    RAISE EXCEPTION 'a paid payment voucher cannot be changed; reverse it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('reversed', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'this payment voucher is finished' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'paid' AND NEW.status NOT IN ('paid', 'reversed') THEN
    RAISE EXCEPTION 'a paid payment voucher can only be reversed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_payment_vouchers_guard BEFORE UPDATE OR DELETE ON "vendor_payment_vouchers" FOR EACH ROW EXECUTE FUNCTION vendor_payment_voucher_guard();--> statement-breakpoint
CREATE FUNCTION vendor_payment_voucher_lines_guard() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM vendor_payment_vouchers WHERE id = COALESCE(NEW.voucher_id, OLD.voucher_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'the invoices on a payment voucher cannot change once it is sent for approval' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_payment_voucher_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "vendor_payment_voucher_lines" FOR EACH ROW EXECUTE FUNCTION vendor_payment_voucher_lines_guard();
