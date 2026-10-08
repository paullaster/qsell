CREATE TABLE "gift_card_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"order_id" text,
	"reason_code" text,
	"note" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"initial_value" numeric(14, 2) NOT NULL,
	"balance" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"customer_id" uuid,
	"note" text,
	"issued_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_cards_balance_chk" CHECK ("gift_cards"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_accounts" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"lifetime_earned" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_accounts_balance_chk" CHECK ("loyalty_accounts"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"points" bigint NOT NULL,
	"order_id" text,
	"expires_at" timestamp with time zone,
	"reason_code" text,
	"note" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text DEFAULT 'Loyalty' NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"points_per_100" numeric(9, 4) NOT NULL,
	"point_value" numeric(9, 4) NOT NULL,
	"min_redeem_points" integer DEFAULT 1 NOT NULL,
	"max_redeem_percent" numeric(5, 2) DEFAULT '100' NOT NULL,
	"expiry_months" integer,
	"tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_tenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"points" bigint,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rebate_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"basis_amount" numeric(16, 2) NOT NULL,
	"program_version" integer NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rebate_balances" (
	"program_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"basis" numeric(16, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rebate_balances_program_id_customer_id_period_key_pk" PRIMARY KEY("program_id","customer_id","period_key")
);
--> statement-breakpoint
CREATE TABLE "rebate_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"period" text NOT NULL,
	"tier_mode" text DEFAULT 'all_sales' NOT NULL,
	"tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rebate_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"basis" numeric(16, 2) NOT NULL,
	"percent" numeric(9, 4) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_status" text DEFAULT 'none' NOT NULL,
	"credit_ref" text,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tendered_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_card_ledger" ADD CONSTRAINT "gift_card_ledger_card_id_gift_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_tenders" ADD CONSTRAINT "order_tenders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_accruals" ADD CONSTRAINT "rebate_accruals_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_accruals" ADD CONSTRAINT "rebate_accruals_program_id_rebate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."rebate_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_balances" ADD CONSTRAINT "rebate_balances_program_id_rebate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."rebate_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_programs" ADD CONSTRAINT "rebate_programs_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_settlements" ADD CONSTRAINT "rebate_settlements_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_settlements" ADD CONSTRAINT "rebate_settlements_program_id_rebate_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."rebate_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rebate_settlements" ADD CONSTRAINT "rebate_settlements_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gift_card_ledger_card_idx" ON "gift_card_ledger" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "gift_card_ledger_order_idx" ON "gift_card_ledger" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_code_uidx" ON "gift_cards" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "gift_cards_company_idx" ON "gift_cards" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "loyalty_ledger_customer_idx" ON "loyalty_ledger" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "loyalty_ledger_order_idx" ON "loyalty_ledger" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_ledger_order_kind_uidx" ON "loyalty_ledger" USING btree ("order_id","kind","customer_id") WHERE "loyalty_ledger"."order_id" is not null and "loyalty_ledger"."kind" in ('earn', 'redeem', 'reverse_redeem');--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_programs_company_uidx" ON "loyalty_programs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "order_tenders_order_idx" ON "order_tenders" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rebate_accruals_source_uidx" ON "rebate_accruals" USING btree ("program_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "rebate_accruals_customer_idx" ON "rebate_accruals" USING btree ("program_id","customer_id","period_key");--> statement-breakpoint
CREATE INDEX "rebate_balances_period_idx" ON "rebate_balances" USING btree ("program_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "rebate_programs_company_code_uidx" ON "rebate_programs" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "rebate_programs_company_status_idx" ON "rebate_programs" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "rebate_settlements_period_uidx" ON "rebate_settlements" USING btree ("program_id","customer_id","period_key") WHERE "rebate_settlements"."status" in ('pending', 'settled');--> statement-breakpoint
CREATE INDEX "rebate_settlements_company_idx" ON "rebate_settlements" USING btree ("company_id","status");--> statement-breakpoint
-- Money and points are facts: the database itself refuses to change or delete a ledger row.
CREATE TRIGGER rebate_accruals_append_only BEFORE UPDATE OR DELETE ON "rebate_accruals" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER loyalty_ledger_append_only BEFORE UPDATE OR DELETE ON "loyalty_ledger" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER gift_card_ledger_append_only BEFORE UPDATE OR DELETE ON "gift_card_ledger" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER order_tenders_append_only BEFORE UPDATE OR DELETE ON "order_tenders" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();
