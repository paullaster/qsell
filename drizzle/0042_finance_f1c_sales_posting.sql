CREATE TABLE "finance_sales_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"event_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"register_id" uuid,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD COLUMN "rebate_expense_account_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD COLUMN "gift_card_liability_account_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD COLUMN "loyalty_provision_account_id" uuid;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD COLUMN "default_business_group" text DEFAULT 'DOMESTIC' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD COLUMN "default_product_group" text DEFAULT 'GOODS' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD COLUMN "output_tax_account_id" uuid;--> statement-breakpoint
ALTER TABLE "finance_sales_postings" ADD CONSTRAINT "finance_sales_postings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_sales_postings_subject_uidx" ON "finance_sales_postings" USING btree ("company_id","kind","subject_id");--> statement-breakpoint
CREATE INDEX "finance_sales_postings_due_idx" ON "finance_sales_postings" USING btree ("next_attempt_at") WHERE "finance_sales_postings"."status" IN ('pending','failed');--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_rebate_expense_account_id_gl_accounts_id_fk" FOREIGN KEY ("rebate_expense_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_gift_card_liability_account_id_gl_accounts_id_fk" FOREIGN KEY ("gift_card_liability_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_posting_groups" ADD CONSTRAINT "customer_posting_groups_loyalty_provision_account_id_gl_accounts_id_fk" FOREIGN KEY ("loyalty_provision_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_output_tax_account_id_gl_accounts_id_fk" FOREIGN KEY ("output_tax_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Companies that already imported a chart get the template's accounts for the new purposes
-- (editable on Posting setup); a company that renumbered its chart simply gets nothing here.
UPDATE "finance_settings" s SET "output_tax_account_id" = a."id"
FROM "gl_accounts" a
WHERE a."company_id" = s."company_id" AND a."no" = '2310' AND a."type" = 'posting' AND s."output_tax_account_id" IS NULL;--> statement-breakpoint
UPDATE "customer_posting_groups" g SET
  "rebate_expense_account_id" = COALESCE(g."rebate_expense_account_id", (SELECT a."id" FROM "gl_accounts" a WHERE a."company_id" = g."company_id" AND a."no" = '6310' AND a."type" = 'posting')),
  "gift_card_liability_account_id" = COALESCE(g."gift_card_liability_account_id", (SELECT a."id" FROM "gl_accounts" a WHERE a."company_id" = g."company_id" AND a."no" = '2230' AND a."type" = 'posting')),
  "loyalty_provision_account_id" = COALESCE(g."loyalty_provision_account_id", (SELECT a."id" FROM "gl_accounts" a WHERE a."company_id" = g."company_id" AND a."no" = '2240' AND a."type" = 'posting'));
