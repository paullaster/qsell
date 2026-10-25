ALTER TABLE "vendor_bank_accounts" ADD COLUMN "replaces_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "proposed_by" text;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "evidence_document_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "callback_by" text;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "callback_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "callback_note" text;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "effective_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "vendor_documents" ADD COLUMN "last_reminder_day" integer;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_accounts_replaces_id_vendor_bank_accounts_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."vendor_bank_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_accounts_evidence_document_id_vendor_documents_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."vendor_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bank_one_pending_uidx" ON "vendor_bank_accounts" USING btree ("vendor_id") WHERE "vendor_bank_accounts"."status" = 'pending_change';--> statement-breakpoint
CREATE INDEX "vendor_bank_pending_idx" ON "vendor_bank_accounts" USING btree ("effective_from") WHERE "vendor_bank_accounts"."status" = 'pending_change';--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_four_eyes_chk" CHECK (("vendor_bank_accounts"."approved_by" IS NULL OR "vendor_bank_accounts"."approved_by" IS DISTINCT FROM "vendor_bank_accounts"."proposed_by") AND ("vendor_bank_accounts"."approved_by" IS NULL OR "vendor_bank_accounts"."approved_by" IS DISTINCT FROM "vendor_bank_accounts"."callback_by"));