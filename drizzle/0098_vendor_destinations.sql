ALTER TABLE "vendor_bank_accounts" ADD COLUMN "kind" text DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_kind_chk" CHECK ("vendor_bank_accounts"."kind" IN ('bank','mpesa_phone','mpesa_paybill','mpesa_till'));--> statement-breakpoint
-- What a destination is (a bank account, or an M-Pesa phone, paybill or till) is part of its details: it is never edited either.
CREATE OR REPLACE FUNCTION vendor_guard_bank_account() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a bank account that has been in use cannot be deleted; retire it instead' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.vendor_id <> OLD.vendor_id OR NEW.bank_name <> OLD.bank_name OR NEW.branch <> OLD.branch
     OR NEW.account_name <> OLD.account_name
     OR NEW.account_last4 <> OLD.account_last4 OR NEW.swift IS DISTINCT FROM OLD.swift
     OR NEW.kind <> OLD.kind OR NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'a vendor bank account cannot be edited; add the new details as a change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
