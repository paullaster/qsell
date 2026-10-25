CREATE TABLE "purchase_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"vendor_invoice_no" text NOT NULL,
	"currency" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"posting_date" date NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"tax_total" numeric(14, 2) NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"register_id" uuid NOT NULL,
	"ledger_entry_id" uuid NOT NULL,
	"posted_by" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_delivery_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"note_no" text NOT NULL,
	"note_date" date NOT NULL,
	"file_id" uuid NOT NULL,
	"matched_rgn_id" uuid
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_invoice_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"invoice_id" uuid NOT NULL,
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
CREATE TABLE "supplier_invoice_line_rgn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"rgn_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	CONSTRAINT "supplier_invoice_line_rgn_qty_chk" CHECK ("supplier_invoice_line_rgn"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"po_line_id" uuid NOT NULL,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"gl_account_id" uuid,
	CONSTRAINT "supplier_invoice_lines_amounts_chk" CHECK ("supplier_invoice_lines"."quantity" > 0 AND "supplier_invoice_lines"."unit_price" >= 0 AND "supplier_invoice_lines"."net_amount" >= 0 AND "supplier_invoice_lines"."tax_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_matches" (
	"invoice_line_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"price_difference" numeric(14, 2) DEFAULT '0' NOT NULL,
	"quantity_difference" numeric(14, 3) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoice_matches_status_chk" CHECK ("supplier_invoice_matches"."status" IN ('ok','exception'))
);
--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"vendor_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"vendor_invoice_no" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"currency" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"notes" text,
	"declaration" boolean DEFAULT false NOT NULL,
	"invoice_file_id" uuid,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"advance_basis" boolean DEFAULT false NOT NULL,
	"created_by_portal_user" text,
	"submitted_at" timestamp with time zone,
	"assigned_to" text,
	"first_action_at" timestamp with time zone,
	"linked_by" text,
	"linked_at" timestamp with time zone,
	"matched_by" text,
	"matched_at" timestamp with time zone,
	"match_override_reason" text,
	"sent_for_approval_by" text,
	"sent_for_approval_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"return_reason_code" text,
	"return_note" text,
	"reject_reason_code" text,
	"reject_note" text,
	"close_reason" text,
	"posted_at" timestamp with time zone,
	"posted_by" text,
	"purchase_invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoices_state_chk" CHECK ("supplier_invoices"."state" IN ('draft','submitted','received','rgn_linked','matched','pending_approval','approved','posted','returned','rejected','closed')),
	CONSTRAINT "supplier_invoices_total_chk" CHECK ("supplier_invoices"."subtotal" >= 0 AND "supplier_invoices"."tax_total" >= 0 AND "supplier_invoices"."total" = "supplier_invoices"."subtotal" + "supplier_invoices"."tax_total"),
	CONSTRAINT "supplier_invoices_posted_chk" CHECK ("supplier_invoices"."state" <> 'posted' OR "supplier_invoices"."purchase_invoice_id" IS NOT NULL),
	CONSTRAINT "supplier_invoices_four_eyes_chk" CHECK ("supplier_invoices"."approved_by" IS NULL OR ("supplier_invoices"."approved_by" IS DISTINCT FROM "supplier_invoices"."linked_by" AND "supplier_invoices"."approved_by" IS DISTINCT FROM "supplier_invoices"."matched_by"))
);
--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "input_tax_account_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "invoice_price_tolerance_percent" numeric(5, 2) DEFAULT '2' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "invoice_price_tolerance_amount" numeric(14, 2) DEFAULT '100' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "invoice_quantity_tolerance_percent" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_delivery_notes" ADD CONSTRAINT "supplier_invoice_delivery_notes_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_delivery_notes" ADD CONSTRAINT "supplier_invoice_delivery_notes_file_id_vendor_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."vendor_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_delivery_notes" ADD CONSTRAINT "supplier_invoice_delivery_notes_matched_rgn_id_rgns_id_fk" FOREIGN KEY ("matched_rgn_id") REFERENCES "public"."rgns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_events" ADD CONSTRAINT "supplier_invoice_events_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_line_rgn" ADD CONSTRAINT "supplier_invoice_line_rgn_invoice_line_id_supplier_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."supplier_invoice_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_line_rgn" ADD CONSTRAINT "supplier_invoice_line_rgn_rgn_line_id_rgn_lines_id_fk" FOREIGN KEY ("rgn_line_id") REFERENCES "public"."rgn_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_po_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_matches" ADD CONSTRAINT "supplier_invoice_matches_invoice_line_id_supplier_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."supplier_invoice_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_invoice_file_id_vendor_files_id_fk" FOREIGN KEY ("invoice_file_id") REFERENCES "public"."vendor_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_invoices_number_uidx" ON "purchase_invoices" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_invoices_supplier_invoice_uidx" ON "purchase_invoices" USING btree ("supplier_invoice_id");--> statement-breakpoint
CREATE INDEX "purchase_invoices_vendor_idx" ON "purchase_invoices" USING btree ("vendor_id","posted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_dn_uidx" ON "supplier_invoice_delivery_notes" USING btree ("invoice_id",lower(btrim("note_no")));--> statement-breakpoint
CREATE INDEX "supplier_invoice_events_idx" ON "supplier_invoice_events" USING btree ("invoice_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_line_rgn_uidx" ON "supplier_invoice_line_rgn" USING btree ("invoice_line_id","rgn_line_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_line_rgn_rgn_idx" ON "supplier_invoice_line_rgn" USING btree ("rgn_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_lines_pos_uidx" ON "supplier_invoice_lines" USING btree ("invoice_id","position");--> statement-breakpoint
CREATE INDEX "supplier_invoice_lines_po_line_idx" ON "supplier_invoice_lines" USING btree ("po_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoices_number_uidx" ON "supplier_invoices" USING btree ("company_id","number") WHERE "supplier_invoices"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoices_vendor_no_uidx" ON "supplier_invoices" USING btree ("vendor_id",regexp_replace(lower("vendor_invoice_no"), '[[:space:]]+', '', 'g')) WHERE "supplier_invoices"."state" NOT IN ('closed','rejected');--> statement-breakpoint
CREATE INDEX "supplier_invoices_queue_idx" ON "supplier_invoices" USING btree ("company_id","state","submitted_at");--> statement-breakpoint
CREATE INDEX "supplier_invoices_vendor_idx" ON "supplier_invoices" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE INDEX "supplier_invoices_po_idx" ON "supplier_invoices" USING btree ("po_id");--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD CONSTRAINT "vendor_settings_input_tax_account_id_gl_accounts_id_fk" FOREIGN KEY ("input_tax_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- The goods an invoice may claim are never more than was accepted.
ALTER TABLE "rgn_lines" ADD CONSTRAINT "rgn_lines_invoiced_chk" CHECK ("rgn_lines"."invoiced_quantity" >= 0 AND "rgn_lines"."invoiced_quantity" <= "rgn_lines"."accepted");--> statement-breakpoint
-- What the vendor sees and staff write is a history that is never rewritten, and a booked invoice never changes.
CREATE TRIGGER supplier_invoice_events_append_only BEFORE UPDATE OR DELETE ON "supplier_invoice_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER purchase_invoices_append_only BEFORE UPDATE OR DELETE ON "purchase_invoices" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE FUNCTION supplier_invoice_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state NOT IN ('draft', 'closed') THEN
      RAISE EXCEPTION 'a submitted invoice cannot be deleted; close or refuse it' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.state = 'posted' THEN
    RAISE EXCEPTION 'a booked invoice cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state IN ('closed', 'rejected') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'this invoice is finished' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number AND NOT (OLD.state = 'submitted' AND NEW.state = 'draft') THEN
    RAISE EXCEPTION 'the invoice number cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.vendor_id <> OLD.vendor_id OR NEW.po_id <> OLD.po_id THEN
    RAISE EXCEPTION 'the vendor and the order of an invoice cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER supplier_invoices_guard BEFORE UPDATE OR DELETE ON "supplier_invoices" FOR EACH ROW EXECUTE FUNCTION supplier_invoice_guard();--> statement-breakpoint
-- Lines belong to the vendor while the invoice is a draft or returned. Afterwards only the account staff choose for a line may change,
-- and once booked nothing does.
CREATE FUNCTION supplier_invoice_guard_lines() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT state INTO st FROM supplier_invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF st IS NULL OR st IN ('draft', 'returned') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF st = 'posted' THEN
    RAISE EXCEPTION 'the lines of a booked invoice cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.invoice_id = OLD.invoice_id AND NEW.position = OLD.position AND NEW.po_line_id = OLD.po_line_id AND NEW.quantity = OLD.quantity
     AND NEW.unit_price = OLD.unit_price AND NEW.tax_rate = OLD.tax_rate AND NEW.net_amount = OLD.net_amount AND NEW.tax_amount = OLD.tax_amount
     AND NEW.description = OLD.description AND NEW.unit = OLD.unit THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the lines of an invoice in process cannot be changed by the vendor' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER supplier_invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "supplier_invoice_lines" FOR EACH ROW EXECUTE FUNCTION supplier_invoice_guard_lines();--> statement-breakpoint
CREATE FUNCTION supplier_invoice_guard_posted_children() RETURNS trigger AS $$
DECLARE
  st text;
  inv uuid;
BEGIN
  IF TG_TABLE_NAME = 'supplier_invoice_line_rgn' THEN
    SELECT i.state INTO st FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id WHERE l.id = COALESCE(NEW.invoice_line_id, OLD.invoice_line_id);
  ELSE
    inv := COALESCE(NEW.invoice_id, OLD.invoice_id);
    SELECT state INTO st FROM supplier_invoices WHERE id = inv;
  END IF;
  IF st = 'posted' THEN
    RAISE EXCEPTION 'a booked invoice cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER supplier_invoice_line_rgn_guard BEFORE INSERT OR UPDATE OR DELETE ON "supplier_invoice_line_rgn" FOR EACH ROW EXECUTE FUNCTION supplier_invoice_guard_posted_children();--> statement-breakpoint
CREATE TRIGGER supplier_invoice_dn_guard BEFORE INSERT OR UPDATE OR DELETE ON "supplier_invoice_delivery_notes" FOR EACH ROW EXECUTE FUNCTION supplier_invoice_guard_posted_children();
