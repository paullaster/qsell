CREATE TABLE "customer_credit_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"group_code" text,
	"effective_from" date NOT NULL,
	"wallet_enabled" boolean DEFAULT false NOT NULL,
	"allow_deposits" boolean DEFAULT true NOT NULL,
	"overpayment_default" text DEFAULT 'ask' NOT NULL,
	"auto_apply" text DEFAULT 'never' NOT NULL,
	"max_balance" numeric(14, 2),
	"label" text DEFAULT 'Wallet' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_wallets_not_negative_chk" CHECK ("customer_wallets"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "wallet_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"source_type" text,
	"source_id" text,
	"ledger_entry_id" uuid,
	"reason_code" text,
	"reason_text" text,
	"register_id" uuid,
	"posting_date" date NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_receipts" ADD COLUMN "is_deposit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_credit_policies" ADD CONSTRAINT "customer_credit_policies_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_wallets" ADD CONSTRAINT "customer_wallets_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_wallets" ADD CONSTRAINT "customer_wallets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_wallet_id_customer_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."customer_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_policies_scope_uidx" ON "customer_credit_policies" USING btree ("company_id",coalesce("group_code", ''),"effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_wallets_customer_currency_uidx" ON "customer_wallets" USING btree ("customer_id","currency");--> statement-breakpoint
CREATE INDEX "customer_wallets_company_idx" ON "customer_wallets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "wallet_entries_wallet_idx" ON "wallet_entries" USING btree ("wallet_id","id");--> statement-breakpoint
CREATE INDEX "wallet_entries_customer_idx" ON "wallet_entries" USING btree ("customer_id","id");--> statement-breakpoint
CREATE INDEX "wallet_entries_source_idx" ON "wallet_entries" USING btree ("source_type","source_id");--> statement-breakpoint
-- The wallet record is a fact: entries cannot be changed or removed, and a wallet is never deleted.
CREATE TRIGGER wallet_entries_append_only BEFORE UPDATE OR DELETE ON "wallet_entries" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE FUNCTION finance_guard_wallet() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a customer wallet cannot be deleted; freeze it instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.customer_id <> OLD.customer_id OR NEW.currency <> OLD.currency OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'a wallet''s customer and currency cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER customer_wallets_guard BEFORE UPDATE OR DELETE ON "customer_wallets" FOR EACH ROW EXECUTE FUNCTION finance_guard_wallet();
