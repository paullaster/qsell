CREATE TABLE "shift_variance_postings" (
	"shift_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"register_id" text,
	"bank_entry_id" bigint,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_variance_postings_status_chk" CHECK ("shift_variance_postings"."status" IN ('pending', 'posted')),
	CONSTRAINT "shift_variance_postings_amount_chk" CHECK ("shift_variance_postings"."amount" <> 0)
);
--> statement-breakpoint
ALTER TABLE "registers" ADD COLUMN "cash_account_id" uuid;--> statement-breakpoint
ALTER TABLE "shift_settings" ADD COLUMN "variance_gl_account_id" uuid;--> statement-breakpoint
ALTER TABLE "shift_variance_postings" ADD CONSTRAINT "shift_variance_postings_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_variance_postings" ADD CONSTRAINT "shift_variance_postings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shift_variance_postings_due_idx" ON "shift_variance_postings" USING btree ("created_at") WHERE "shift_variance_postings"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_cash_account_id_bank_accounts_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_settings" ADD CONSTRAINT "shift_settings_variance_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("variance_gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;