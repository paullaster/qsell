CREATE TABLE "cash_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"number" text NOT NULL,
	"count_date" date NOT NULL,
	"currency" text NOT NULL,
	"denominations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counted_amount" numeric(20, 2) NOT NULL,
	"expected_amount" numeric(20, 2) NOT NULL,
	"difference" numeric(20, 2) NOT NULL,
	"variance_gl_account_id" uuid,
	"note" text,
	"register_id" uuid,
	"bank_entry_id" bigint,
	"counted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_counts_counted_chk" CHECK ("cash_counts"."counted_amount" >= 0),
	CONSTRAINT "cash_counts_difference_chk" CHECK ("cash_counts"."difference" = "cash_counts"."counted_amount" - "cash_counts"."expected_amount")
);
--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_variance_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("variance_gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_counts_company_number_uidx" ON "cash_counts" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "cash_counts_account_idx" ON "cash_counts" USING btree ("bank_account_id","count_date","created_at");--> statement-breakpoint
-- A count is a record of what was found: it is kept, never rewritten or deleted. A wrong one is answered by counting again.
CREATE FUNCTION cash_counts_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a cash count is kept as it was made; count again to correct it' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER cash_counts_no_change BEFORE UPDATE OR DELETE ON "cash_counts" FOR EACH ROW EXECUTE FUNCTION cash_counts_guard();
