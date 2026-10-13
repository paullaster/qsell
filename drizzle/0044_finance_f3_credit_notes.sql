CREATE TABLE "credit_note_accounting" (
	"credit_note_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"register_id" uuid,
	"currency" text NOT NULL,
	"gross" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"applied" numeric(14, 2) NOT NULL,
	"excess" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_note_resolutions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credit_note_resolutions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"wallet_entry_id" bigint,
	"application_id" uuid,
	"register_id" uuid,
	"reason_code" text,
	"reason_text" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_receipt_confirmations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "return_receipt_confirmations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"receipt_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"condition" text NOT NULL,
	"disposition" text NOT NULL,
	"stock_added" boolean DEFAULT false NOT NULL,
	"note" text,
	"confirmed_by" text NOT NULL,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "return_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"description" text NOT NULL,
	"expected_qty" integer NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"unit_cost" numeric(14, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "return_receipt_lines_qty_chk" CHECK ("return_receipt_lines"."received_qty" >= 0 AND "return_receipt_lines"."received_qty" <= "return_receipt_lines"."expected_qty")
);
--> statement-breakpoint
CREATE TABLE "return_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"branch_id" uuid,
	"status" text DEFAULT 'awaiting_goods' NOT NULL,
	"requested_by" text NOT NULL,
	"closed_by" text,
	"close_reason_code" text,
	"close_reason_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "customer_credit_policies" ADD COLUMN "credit_note_excess_default" text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_note_accounting" ADD CONSTRAINT "credit_note_accounting_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_accounting" ADD CONSTRAINT "credit_note_accounting_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_resolutions" ADD CONSTRAINT "credit_note_resolutions_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_resolutions" ADD CONSTRAINT "credit_note_resolutions_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_receipt_confirmations" ADD CONSTRAINT "return_receipt_confirmations_receipt_id_return_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."return_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_receipt_confirmations" ADD CONSTRAINT "return_receipt_confirmations_line_id_return_receipt_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."return_receipt_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_receipt_id_return_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."return_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_receipts" ADD CONSTRAINT "return_receipts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_resolutions_cn_idx" ON "credit_note_resolutions" USING btree ("credit_note_id","id");--> statement-breakpoint
CREATE INDEX "return_receipt_confirmations_receipt_idx" ON "return_receipt_confirmations" USING btree ("receipt_id","id");--> statement-breakpoint
CREATE INDEX "return_receipt_lines_receipt_idx" ON "return_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_receipts_company_number_uidx" ON "return_receipts" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "return_receipts_credit_note_uidx" ON "return_receipts" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX "return_receipts_status_idx" ON "return_receipts" USING btree ("company_id","status","created_at");--> statement-breakpoint
-- A credit note's accounting and the confirmations of returned goods are records: append-only.
CREATE TRIGGER credit_note_resolutions_append_only BEFORE UPDATE OR DELETE ON "credit_note_resolutions" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER return_receipt_confirmations_append_only BEFORE UPDATE OR DELETE ON "return_receipt_confirmations" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER credit_note_accounting_no_delete BEFORE DELETE ON "credit_note_accounting" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();
