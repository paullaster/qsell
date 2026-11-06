CREATE TABLE "delivery_cost_postings" (
	"cost_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text NOT NULL,
	"register_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_cost_postings_chk" CHECK (("delivery_cost_postings"."status" = 'posted') = ("delivery_cost_postings"."register_id" IS NOT NULL OR "delivery_cost_postings"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "delivery_pay_payout_items" (
	"payout_id" uuid NOT NULL,
	"cost_id" uuid NOT NULL,
	CONSTRAINT "delivery_pay_payout_items_payout_id_cost_id_pk" PRIMARY KEY("payout_id","cost_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_pay_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"rider_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"paid_on" date NOT NULL,
	"reference" text,
	"note" text,
	"paid_by" text NOT NULL,
	"register_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_pay_payouts_amount_chk" CHECK ("delivery_pay_payouts"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "delivery_pay_settings" ADD COLUMN "expense_gl_account_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_pay_settings" ADD COLUMN "payable_gl_account_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_cost_postings" ADD CONSTRAINT "delivery_cost_postings_cost_id_delivery_costs_id_fk" FOREIGN KEY ("cost_id") REFERENCES "public"."delivery_costs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_cost_postings" ADD CONSTRAINT "delivery_cost_postings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_pay_payout_items" ADD CONSTRAINT "delivery_pay_payout_items_payout_id_delivery_pay_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."delivery_pay_payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_pay_payout_items" ADD CONSTRAINT "delivery_pay_payout_items_cost_id_delivery_costs_id_fk" FOREIGN KEY ("cost_id") REFERENCES "public"."delivery_costs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_pay_payouts" ADD CONSTRAINT "delivery_pay_payouts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_pay_payouts" ADD CONSTRAINT "delivery_pay_payouts_rider_id_delivery_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."delivery_riders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_pay_payouts" ADD CONSTRAINT "delivery_pay_payouts_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_pay_payouts" ADD CONSTRAINT "delivery_pay_payouts_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_cost_postings_due_idx" ON "delivery_cost_postings" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_pay_payout_items_cost_uidx" ON "delivery_pay_payout_items" USING btree ("cost_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_pay_payouts_number_uidx" ON "delivery_pay_payouts" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "delivery_pay_payouts_rider_idx" ON "delivery_pay_payouts" USING btree ("rider_id","created_at");--> statement-breakpoint
ALTER TABLE "delivery_pay_settings" ADD CONSTRAINT "delivery_pay_settings_expense_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("expense_gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_pay_settings" ADD CONSTRAINT "delivery_pay_settings_payable_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("payable_gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- A payout to a rider, and which costs it paid, are kept for good.
CREATE TRIGGER delivery_pay_payouts_no_change BEFORE UPDATE OR DELETE ON "delivery_pay_payouts" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();--> statement-breakpoint
CREATE TRIGGER delivery_pay_payout_items_no_change BEFORE UPDATE OR DELETE ON "delivery_pay_payout_items" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
