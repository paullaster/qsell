CREATE TABLE "withholding_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"paid_on" date NOT NULL,
	"period" text NOT NULL,
	"code_name" text NOT NULL,
	"rate_percent" numeric(5, 2) NOT NULL,
	"base_amount" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"cancel_reason" text,
	"cancelled_at" timestamp with time zone,
	"created_by" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withholding_certificates_status_chk" CHECK ("withholding_certificates"."status" IN ('issued','cancelled')),
	CONSTRAINT "withholding_certificates_amount_chk" CHECK ("withholding_certificates"."amount" > 0 AND "withholding_certificates"."base_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "withholding_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_percent" numeric(5, 2) NOT NULL,
	"base" text DEFAULT 'net' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withholding_codes_rate_chk" CHECK ("withholding_codes"."rate_percent" > 0 AND "withholding_codes"."rate_percent" <= 100),
	CONSTRAINT "withholding_codes_base_chk" CHECK ("withholding_codes"."base" IN ('net','gross'))
);
--> statement-breakpoint
ALTER TABLE "vendor_payment_voucher_lines" ADD COLUMN "close_remainder" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_voucher_lines" ADD COLUMN "discount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_voucher_lines" ADD COLUMN "tolerance" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_voucher_lines" ADD COLUMN "withholding_base" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_voucher_lines" ADD COLUMN "withholding" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD COLUMN "withholding_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD COLUMN "discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD COLUMN "tolerance_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD COLUMN "cash_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "payment_tolerance_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "withholding_code_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "early_discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "early_discount_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "withholding_certificates" ADD CONSTRAINT "withholding_certificates_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificates" ADD CONSTRAINT "withholding_certificates_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_certificates" ADD CONSTRAINT "withholding_certificates_voucher_id_vendor_payment_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vendor_payment_vouchers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withholding_codes" ADD CONSTRAINT "withholding_codes_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "withholding_certificates_number_uidx" ON "withholding_certificates" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "withholding_certificates_voucher_uidx" ON "withholding_certificates" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "withholding_certificates_vendor_idx" ON "withholding_certificates" USING btree ("vendor_id","issued_at");--> statement-breakpoint
CREATE INDEX "withholding_certificates_period_idx" ON "withholding_certificates" USING btree ("company_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "withholding_codes_company_code_uidx" ON "withholding_codes" USING btree ("company_id",lower("code"));--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_withholding_code_id_withholding_codes_id_fk" FOREIGN KEY ("withholding_code_id") REFERENCES "public"."withholding_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Vouchers made before withholding existed paid their whole amount in cash.--> statement-breakpoint
UPDATE "vendor_payment_vouchers" SET "cash_amount" = "amount";--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD CONSTRAINT "vendor_payment_vouchers_settle_chk" CHECK ("vendor_payment_vouchers"."withholding_amount" >= 0 AND "vendor_payment_vouchers"."discount_amount" >= 0 AND "vendor_payment_vouchers"."tolerance_amount" >= 0 AND "vendor_payment_vouchers"."cash_amount" >= 0 AND "vendor_payment_vouchers"."cash_amount" = "vendor_payment_vouchers"."amount" - "vendor_payment_vouchers"."discount_amount" - "vendor_payment_vouchers"."withholding_amount");
--> statement-breakpoint
-- A certificate is proof of tax withheld: only its cancellation (a reversed payment) may change it.
CREATE FUNCTION withholding_certificate_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a withholding certificate cannot be deleted; a reversed payment cancels it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.number <> OLD.number OR NEW.vendor_id <> OLD.vendor_id OR NEW.voucher_id <> OLD.voucher_id OR NEW.amount <> OLD.amount
     OR NEW.base_amount <> OLD.base_amount OR NEW.rate_percent <> OLD.rate_percent OR NEW.period <> OLD.period OR NEW.paid_on <> OLD.paid_on THEN
    RAISE EXCEPTION 'a withholding certificate cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled certificate stays cancelled' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER withholding_certificates_guard BEFORE UPDATE OR DELETE ON "withholding_certificates" FOR EACH ROW EXECUTE FUNCTION withholding_certificate_guard();--> statement-breakpoint
-- The voucher guard also keeps what was settled: tax, discount, tolerance and cash.
CREATE OR REPLACE FUNCTION vendor_payment_voucher_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'a payment voucher that has gone further than a draft cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('paid', 'reversed', 'cancelled') AND (NEW.vendor_id <> OLD.vendor_id OR NEW.amount <> OLD.amount OR NEW.method_id <> OLD.method_id
     OR NEW.kind <> OLD.kind OR NEW.number IS DISTINCT FROM OLD.number OR NEW.currency <> OLD.currency OR NEW.advance_id IS DISTINCT FROM OLD.advance_id
     OR NEW.vendor_bank_account_id IS DISTINCT FROM OLD.vendor_bank_account_id OR NEW.cash_amount <> OLD.cash_amount
     OR NEW.withholding_amount <> OLD.withholding_amount OR NEW.discount_amount <> OLD.discount_amount OR NEW.tolerance_amount <> OLD.tolerance_amount) THEN
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
-- The invoices on a voucher are fixed once it is sent for approval, except the settlement worked out for each (set at approval).
CREATE OR REPLACE FUNCTION vendor_payment_voucher_lines_guard() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM vendor_payment_vouchers WHERE id = COALESCE(NEW.voucher_id, OLD.voucher_id);
  IF st IS NULL OR st = 'draft' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND st = 'pending_approval' AND NEW.voucher_id = OLD.voucher_id AND NEW.purchase_invoice_id = OLD.purchase_invoice_id
     AND NEW.amount = OLD.amount AND NEW.close_remainder = OLD.close_remainder THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the invoices on a payment voucher cannot change once it is sent for approval' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
