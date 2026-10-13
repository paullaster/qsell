-- Payment providers belong to the company; everything specific (branch, bank account, G/L account,
-- paybill or till number) is on the payment method, and a method goes through exactly one provider.

-- ── 1. Providers become company-wide ────────────────────────────────────────
ALTER TABLE "payment_provider_configs" DROP CONSTRAINT "payment_provider_configs_branch_id_branches_id_fk";--> statement-breakpoint
DROP INDEX "payment_provider_configs_branch_provider_uidx";--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ALTER COLUMN "branch_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "payment_provider_configs" p SET "company_id" = b."company_id" FROM "branches" b WHERE b."id" = p."branch_id";--> statement-breakpoint
-- Switched-off accounts with nothing saved were only placeholders the old screen made for every
-- branch; they carry no configuration, so they go. Anything with credentials, an enabled switch,
-- a payment attempt or a link from a method or bank account stays.
DELETE FROM "payment_provider_configs" p
WHERE p."is_enabled" = false AND p."credentials_encrypted" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "payment_attempts" a WHERE a."provider_config_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "payment_methods" m WHERE m."collect_provider_config_id" = p."id" OR m."payout_provider_config_id" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "bank_accounts" ba WHERE ba."provider_config_id" = p."id");--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
-- The same service configured for several branches becomes several providers, named by branch.
UPDATE "payment_provider_configs" p SET "display_name" = p."display_name" || ' — ' || b."name"
FROM "branches" b
WHERE b."id" = p."branch_id"
  AND (SELECT count(*) FROM "payment_provider_configs" q WHERE q."company_id" = p."company_id" AND lower(q."display_name") = lower(p."display_name")) > 1;--> statement-breakpoint
UPDATE "payment_provider_configs" p SET "display_name" = p."display_name" || ' (' || substr(p."id"::text, 1, 4) || ')'
WHERE (SELECT count(*) FROM "payment_provider_configs" q WHERE q."company_id" = p."company_id" AND lower(q."display_name") = lower(p."display_name")) > 1;--> statement-breakpoint
INSERT INTO "payment_provider_configs" ("company_id", "branch_id", "provider_code", "is_system", "display_name", "is_enabled", "environment", "api_base_url", "settings")
SELECT c."id", NULL, 'manual', true, 'Manual (no outside service)', true, 'production', 'manual://none', '{}'::jsonb
FROM "company_settings" c
WHERE NOT EXISTS (SELECT 1 FROM "payment_provider_configs" p WHERE p."company_id" = c."id" AND p."provider_code" = 'manual');--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD CONSTRAINT "payment_provider_configs_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD CONSTRAINT "payment_provider_configs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_configs_company_name_uidx" ON "payment_provider_configs" USING btree ("company_id",lower("display_name"));--> statement-breakpoint
CREATE INDEX "payment_provider_configs_company_idx" ON "payment_provider_configs" USING btree ("company_id");--> statement-breakpoint

-- ── 2. Methods carry provider, branch, G/L account and the number ───────────
ALTER TABLE "payment_methods" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "gl_account_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "channel_kind" text;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD COLUMN "channel_number" text;--> statement-breakpoint
UPDATE "payment_methods" m SET "gl_account_id" = b."gl_account_id" FROM "bank_accounts" b WHERE b."id" = m."balancing_bank_account_id";--> statement-breakpoint
-- A method that already named a provider keeps it (and that provider's branch).
UPDATE "payment_methods" m SET "provider_id" = COALESCE(m."collect_provider_config_id", m."payout_provider_config_id"),
  "branch_id" = (SELECT p."branch_id" FROM "payment_provider_configs" p WHERE p."id" = COALESCE(m."collect_provider_config_id", m."payout_provider_config_id"))
WHERE m."collect_provider_config_id" IS NOT NULL OR m."payout_provider_config_id" IS NOT NULL;--> statement-breakpoint
-- A method that stands for an old provider code goes through the provider(s) of that code: the first
-- one takes the method itself, each further branch's provider gets a copy for its branch.
DO $$
DECLARE
  m record;
  p record;
  n int;
BEGIN
  FOR m IN SELECT * FROM "payment_methods" WHERE "provider_id" IS NULL ORDER BY "created_at" LOOP
    n := 0;
    FOR p IN
      SELECT pc.* FROM "payment_provider_configs" pc
      WHERE pc."company_id" = m."company_id" AND pc."provider_code" <> 'manual' AND m."legacy_codes" ? pc."provider_code"
      ORDER BY pc."created_at", pc."id"
    LOOP
      n := n + 1;
      IF n = 1 THEN
        UPDATE "payment_methods" SET "provider_id" = p."id", "branch_id" = p."branch_id" WHERE "id" = m."id";
      ELSE
        INSERT INTO "payment_methods" ("company_id", "code", "name", "kind", "balancing_bank_account_id", "requires_reference", "requires_evidence", "requires_counterparty",
          "usable_for", "settlement_mode", "settlement_days", "fee_policy", "limits", "refund_destination", "legacy_codes", "enabled", "sort_order", "created_by",
          "provider_id", "branch_id", "gl_account_id")
        VALUES (m."company_id", m."code" || '-' || upper(substr(p."id"::text, 1, 4)),
          m."name" || COALESCE(' — ' || (SELECT b."name" FROM "branches" b WHERE b."id" = p."branch_id"), ''),
          m."kind", m."balancing_bank_account_id", m."requires_reference", m."requires_evidence", m."requires_counterparty",
          m."usable_for", m."settlement_mode", m."settlement_days", m."fee_policy", m."limits", m."refund_destination", m."legacy_codes", m."enabled", m."sort_order", m."created_by",
          p."id", p."branch_id", m."gl_account_id");
      END IF;
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint
-- Everything else (cash, cheque, bank deposit...) goes through the built-in Manual provider.
UPDATE "payment_methods" m SET "provider_id" = (SELECT p."id" FROM "payment_provider_configs" p WHERE p."company_id" = m."company_id" AND p."provider_code" = 'manual' LIMIT 1)
WHERE m."provider_id" IS NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ALTER COLUMN "provider_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ALTER COLUMN "gl_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_provider_id_payment_provider_configs_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_methods_provider_idx" ON "payment_methods" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "payment_methods_gl_idx" ON "payment_methods" USING btree ("gl_account_id");--> statement-breakpoint
ALTER TABLE "payment_methods" DROP CONSTRAINT "payment_methods_collect_provider_config_id_payment_provider_configs_id_fk";--> statement-breakpoint
ALTER TABLE "payment_methods" DROP CONSTRAINT "payment_methods_payout_provider_config_id_payment_provider_configs_id_fk";--> statement-breakpoint
ALTER TABLE "payment_methods" DROP COLUMN "collect_provider_config_id";--> statement-breakpoint
ALTER TABLE "payment_methods" DROP COLUMN "payout_provider_config_id";--> statement-breakpoint

-- ── 3. Every bank movement records the G/L account it posted to ─────────────
ALTER TABLE "bank_ledger_entries" ADD COLUMN "gl_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_ledger_entries" DISABLE TRIGGER "bank_ledger_append_only";--> statement-breakpoint
UPDATE "bank_ledger_entries" e SET "gl_account_id" = b."gl_account_id" FROM "bank_accounts" b WHERE b."id" = e."bank_account_id";--> statement-breakpoint
ALTER TABLE "bank_ledger_entries" ENABLE TRIGGER "bank_ledger_append_only";--> statement-breakpoint
ALTER TABLE "bank_ledger_entries" ALTER COLUMN "gl_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_ledger_entries" ADD CONSTRAINT "bank_ledger_entries_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_ledger_gl_idx" ON "bank_ledger_entries" USING btree ("gl_account_id");--> statement-breakpoint

-- ── 4. The bank account is the real-world account only ──────────────────────
ALTER TABLE "bank_accounts" DROP CONSTRAINT "bank_accounts_gl_account_id_gl_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "bank_accounts" DROP CONSTRAINT "bank_accounts_branch_id_branches_id_fk";--> statement-breakpoint
DROP INDEX "bank_accounts_gl_idx";--> statement-breakpoint
ALTER TABLE "bank_accounts" DROP COLUMN "gl_account_id";--> statement-breakpoint
ALTER TABLE "bank_accounts" DROP COLUMN "branch_id";--> statement-breakpoint

-- ── 5. A refund remembers the method it was paid out through ────────────────
ALTER TABLE "refund_requests" ADD COLUMN "paid_from_method_id" uuid;--> statement-breakpoint
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_paid_from_method_id_payment_methods_id_fk" FOREIGN KEY ("paid_from_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;
