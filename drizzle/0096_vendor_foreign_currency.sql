ALTER TABLE "vendor_ledger_entries" ADD COLUMN "rate" numeric(24, 8) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD COLUMN "rate" numeric(24, 8) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD COLUMN "fx_register_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD COLUMN "fx_difference" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- The rate an entry was booked at is part of what was posted: it never changes.
CREATE OR REPLACE FUNCTION finance_guard_vendor_ledger() RETURNS trigger AS $$
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
     OR NEW.rate <> OLD.rate
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
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Posting groups made before foreign currency get the chart's exchange gain and loss accounts when it has them.
UPDATE "vendor_posting_groups" g SET "fx_gain_account_id" = (SELECT a."id" FROM "gl_accounts" a WHERE a."company_id" = g."company_id" AND a."no" = '4410' AND a."type" = 'posting' LIMIT 1) WHERE g."fx_gain_account_id" IS NULL;--> statement-breakpoint
UPDATE "vendor_posting_groups" g SET "fx_loss_account_id" = (SELECT a."id" FROM "gl_accounts" a WHERE a."company_id" = g."company_id" AND a."no" = '6700' AND a."type" = 'posting' LIMIT 1) WHERE g."fx_loss_account_id" IS NULL;
