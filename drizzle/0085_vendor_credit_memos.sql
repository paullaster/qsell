CREATE TABLE "vendor_credit_memo_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_credit_memo_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"memo_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_credit_memo_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memo_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"mode" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	CONSTRAINT "vendor_credit_memo_lines_chk" CHECK ("vendor_credit_memo_lines"."mode" IN ('quantity','price') AND "vendor_credit_memo_lines"."quantity" > 0 AND "vendor_credit_memo_lines"."unit_price" > 0 AND "vendor_credit_memo_lines"."net_amount" > 0 AND "vendor_credit_memo_lines"."tax_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vendor_credit_memos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"vendor_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"vendor_credit_no" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"currency" text NOT NULL,
	"credit_date" date NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"notes" text,
	"file_id" uuid,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_by_portal_user" text,
	"submitted_at" timestamp with time zone,
	"assigned_to" text,
	"first_action_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"return_reason_code" text,
	"return_note" text,
	"reject_reason_code" text,
	"reject_note" text,
	"close_reason" text,
	"posted_at" timestamp with time zone,
	"posted_by" text,
	"register_id" uuid,
	"ledger_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_credit_memos_state_chk" CHECK ("vendor_credit_memos"."state" IN ('draft','submitted','received','approved','posted','returned','rejected','closed')),
	CONSTRAINT "vendor_credit_memos_total_chk" CHECK ("vendor_credit_memos"."subtotal" >= 0 AND "vendor_credit_memos"."tax_total" >= 0 AND "vendor_credit_memos"."total" = "vendor_credit_memos"."subtotal" + "vendor_credit_memos"."tax_total"),
	CONSTRAINT "vendor_credit_memos_posted_chk" CHECK ("vendor_credit_memos"."state" <> 'posted' OR ("vendor_credit_memos"."register_id" IS NOT NULL AND "vendor_credit_memos"."ledger_entry_id" IS NOT NULL)),
	CONSTRAINT "vendor_credit_memos_four_eyes_chk" CHECK ("vendor_credit_memos"."approved_by" IS NULL OR "vendor_credit_memos"."approved_by" IS DISTINCT FROM "vendor_credit_memos"."assigned_to")
);
--> statement-breakpoint
ALTER TABLE "vendor_credit_memo_events" ADD CONSTRAINT "vendor_credit_memo_events_memo_id_vendor_credit_memos_id_fk" FOREIGN KEY ("memo_id") REFERENCES "public"."vendor_credit_memos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_memo_lines" ADD CONSTRAINT "vendor_credit_memo_lines_memo_id_vendor_credit_memos_id_fk" FOREIGN KEY ("memo_id") REFERENCES "public"."vendor_credit_memos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_memo_lines" ADD CONSTRAINT "vendor_credit_memo_lines_invoice_line_id_supplier_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."supplier_invoice_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_memos" ADD CONSTRAINT "vendor_credit_memos_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_memos" ADD CONSTRAINT "vendor_credit_memos_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_memos" ADD CONSTRAINT "vendor_credit_memos_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_memos" ADD CONSTRAINT "vendor_credit_memos_file_id_vendor_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."vendor_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_credit_memo_events_idx" ON "vendor_credit_memo_events" USING btree ("memo_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_credit_memo_lines_pos_uidx" ON "vendor_credit_memo_lines" USING btree ("memo_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_credit_memo_lines_line_uidx" ON "vendor_credit_memo_lines" USING btree ("memo_id","invoice_line_id");--> statement-breakpoint
CREATE INDEX "vendor_credit_memo_lines_invoice_line_idx" ON "vendor_credit_memo_lines" USING btree ("invoice_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_credit_memos_number_uidx" ON "vendor_credit_memos" USING btree ("company_id","number") WHERE "vendor_credit_memos"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_credit_memos_vendor_no_uidx" ON "vendor_credit_memos" USING btree ("vendor_id",regexp_replace(lower("vendor_credit_no"), '[[:space:]]+', '', 'g')) WHERE "vendor_credit_memos"."state" NOT IN ('closed','rejected');--> statement-breakpoint
CREATE INDEX "vendor_credit_memos_queue_idx" ON "vendor_credit_memos" USING btree ("company_id","state","submitted_at");--> statement-breakpoint
CREATE INDEX "vendor_credit_memos_invoice_idx" ON "vendor_credit_memos" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "vendor_credit_memos_vendor_idx" ON "vendor_credit_memos" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE TRIGGER vendor_credit_memo_events_append_only BEFORE UPDATE OR DELETE ON "vendor_credit_memo_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- A booked credit memo never changes, a finished one stays finished, and what it is for and whose it is cannot be moved.
CREATE FUNCTION vendor_credit_memo_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state NOT IN ('draft', 'closed') THEN
      RAISE EXCEPTION 'a submitted credit memo cannot be deleted; close or refuse it' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.state = 'posted' THEN
    RAISE EXCEPTION 'a booked credit memo cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state IN ('closed', 'rejected') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'this credit memo is finished' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.vendor_id <> OLD.vendor_id OR NEW.invoice_id <> OLD.invoice_id THEN
    RAISE EXCEPTION 'the vendor and the invoice of a credit memo cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_credit_memos_guard BEFORE UPDATE OR DELETE ON "vendor_credit_memos" FOR EACH ROW EXECUTE FUNCTION vendor_credit_memo_guard();--> statement-breakpoint
-- The lines belong to the vendor while the credit memo is a draft or returned; after that nobody changes them.
CREATE FUNCTION vendor_credit_memo_lines_guard() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT state INTO st FROM vendor_credit_memos WHERE id = COALESCE(NEW.memo_id, OLD.memo_id);
  IF st IS NULL OR st IN ('draft', 'returned') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'the lines of a credit memo in process cannot be changed' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_credit_memo_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "vendor_credit_memo_lines" FOR EACH ROW EXECUTE FUNCTION vendor_credit_memo_lines_guard();
