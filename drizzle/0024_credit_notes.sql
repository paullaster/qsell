CREATE TABLE "credit_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"module" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_ref" text NOT NULL,
	"credit_note_no" text NOT NULL,
	"original_document_key" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_note" text,
	"currency" text NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"kra_status" text DEFAULT 'pending' NOT NULL,
	"issued_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_lines_cn_idx" ON "credit_note_lines" USING btree ("credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_no_uidx" ON "credit_notes" USING btree ("credit_note_no");--> statement-breakpoint
CREATE INDEX "credit_notes_original_idx" ON "credit_notes" USING btree ("original_document_key");--> statement-breakpoint
CREATE INDEX "credit_notes_source_idx" ON "credit_notes" USING btree ("source_kind","source_id");