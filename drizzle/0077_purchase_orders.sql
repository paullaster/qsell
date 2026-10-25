CREATE TABLE "purchase_order_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"reason" text NOT NULL,
	"proposed" jsonb NOT NULL,
	"needs_approval" boolean NOT NULL,
	"proposed_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"applied_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_amendments_status_chk" CHECK ("purchase_order_amendments"."status" IN ('pending_approval','applied','rejected','withdrawn')),
	CONSTRAINT "purchase_order_amendments_approver_chk" CHECK ("purchase_order_amendments"."decided_by" IS NULL OR "purchase_order_amendments"."status" <> 'applied' OR NOT "purchase_order_amendments"."needs_approval" OR "purchase_order_amendments"."decided_by" IS DISTINCT FROM "purchase_order_amendments"."proposed_by")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"po_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" text,
	"description" text NOT NULL,
	"specification" text,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"expected_date" date,
	"award_id" uuid,
	"received_quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	"invoiced_quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	"cancelled_quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_order_lines_qty_chk" CHECK ("purchase_order_lines"."quantity" > 0 AND "purchase_order_lines"."unit_price" >= 0),
	CONSTRAINT "purchase_order_lines_discount_chk" CHECK ("purchase_order_lines"."discount_percent" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"vendor_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"rfq_id" uuid,
	"quote_id" uuid,
	"order_date" date NOT NULL,
	"expected_date" date,
	"branch_id" uuid,
	"currency" text NOT NULL,
	"payment_terms" text,
	"delivery_terms" text,
	"notes_to_vendor" text,
	"internal_notes" text,
	"requires_advance_payment" boolean DEFAULT false NOT NULL,
	"no_rfq" boolean DEFAULT false NOT NULL,
	"no_rfq_reason" text,
	"qualification_override_reason" text,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"buyer_id" text,
	"created_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"confirmation_note" text,
	"cancel_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_status_chk" CHECK ("purchase_orders"."status" IN ('draft','pending_approval','approved','sent','confirmed','amendment_pending','partially_received','received','partially_invoiced','invoiced','closed','cancelled')),
	CONSTRAINT "purchase_orders_no_rfq_chk" CHECK (NOT "purchase_orders"."no_rfq" OR "purchase_orders"."no_rfq_reason" IS NOT NULL),
	CONSTRAINT "purchase_orders_approver_chk" CHECK ("purchase_orders"."approved_by" IS NULL OR "purchase_orders"."approved_by" IS DISTINCT FROM "purchase_orders"."created_by")
);
--> statement-breakpoint
CREATE TABLE "vendor_advance_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"due_date" date,
	"reason" text NOT NULL,
	"bank_account_id" uuid,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"decision_note" text,
	"voucher_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_advance_payments_status_chk" CHECK ("vendor_advance_payments"."status" IN ('draft','pending_approval','approved','paid','applied','refunded','written_off','cancelled')),
	CONSTRAINT "vendor_advance_payments_amount_chk" CHECK ("vendor_advance_payments"."amount" > 0),
	CONSTRAINT "vendor_advance_payments_approver_chk" CHECK ("vendor_advance_payments"."approved_by" IS NULL OR "vendor_advance_payments"."approved_by" IS DISTINCT FROM "vendor_advance_payments"."created_by")
);
--> statement-breakpoint
CREATE TABLE "vendor_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"rfq_required_above" numeric(14, 2),
	"amendment_tolerance_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_order_amendments" ADD CONSTRAINT "purchase_order_amendments_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_events" ADD CONSTRAINT "purchase_order_events_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_award_id_rfq_awards_id_fk" FOREIGN KEY ("award_id") REFERENCES "public"."rfq_awards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_versions" ADD CONSTRAINT "purchase_order_versions_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_category_id_procurement_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."procurement_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_quote_id_rfq_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."rfq_quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_advance_payments" ADD CONSTRAINT "vendor_advance_payments_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_advance_payments" ADD CONSTRAINT "vendor_advance_payments_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_advance_payments" ADD CONSTRAINT "vendor_advance_payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_advance_payments" ADD CONSTRAINT "vendor_advance_payments_bank_account_id_vendor_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."vendor_bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD CONSTRAINT "vendor_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_amendments_open_uidx" ON "purchase_order_amendments" USING btree ("po_id") WHERE "purchase_order_amendments"."status" = 'pending_approval';--> statement-breakpoint
CREATE INDEX "purchase_order_events_po_idx" ON "purchase_order_events" USING btree ("po_id","id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_po_idx" ON "purchase_order_lines" USING btree ("po_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_versions_uidx" ON "purchase_order_versions" USING btree ("po_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_company_number_uidx" ON "purchase_orders" USING btree ("company_id","number") WHERE "purchase_orders"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_rfq_vendor_uidx" ON "purchase_orders" USING btree ("rfq_id","vendor_id") WHERE "purchase_orders"."rfq_id" IS NOT NULL AND "purchase_orders"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "purchase_orders_company_status_idx" ON "purchase_orders" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "purchase_orders_vendor_idx" ON "purchase_orders" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_advance_payments_live_uidx" ON "vendor_advance_payments" USING btree ("po_id") WHERE "vendor_advance_payments"."status" IN ('draft','pending_approval','approved','paid');--> statement-breakpoint
CREATE INDEX "vendor_advance_payments_company_idx" ON "vendor_advance_payments" USING btree ("company_id","status");--> statement-breakpoint
-- The history of an order, and every version that was released, is a record: added to, never changed.
CREATE TRIGGER purchase_order_events_append_only BEFORE UPDATE OR DELETE ON "purchase_order_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER purchase_order_versions_append_only BEFORE UPDATE OR DELETE ON "purchase_order_versions" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- What was ordered cannot be changed once the order is past draft, except by an amendment (which says so for its own transaction),
-- or by receiving and invoicing, which only move their own counters.
CREATE FUNCTION po_guard_lines() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.po_id = OLD.po_id AND NEW.position = OLD.position AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.description = OLD.description AND NEW.specification IS NOT DISTINCT FROM OLD.specification AND NEW.quantity = OLD.quantity
     AND NEW.unit = OLD.unit AND NEW.unit_price = OLD.unit_price AND NEW.discount_percent = OLD.discount_percent AND NEW.tax_rate = OLD.tax_rate
     AND NEW.line_total = OLD.line_total AND NEW.expected_date IS NOT DISTINCT FROM OLD.expected_date AND NEW.award_id IS NOT DISTINCT FROM OLD.award_id THEN
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM purchase_orders WHERE id = COALESCE(NEW.po_id, OLD.po_id);
  IF st IS NULL OR st = 'draft' OR current_setting('qsell.po_amend', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'the lines of a released purchase order change only through an amendment' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER purchase_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "purchase_order_lines" FOR EACH ROW EXECUTE FUNCTION po_guard_lines();--> statement-breakpoint
CREATE FUNCTION po_guard_header() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' OR OLD.number IS NOT NULL THEN
      RAISE EXCEPTION 'a purchase order that was approved cannot be deleted; cancel it' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number THEN
    RAISE EXCEPTION 'a purchase order number never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status NOT IN ('draft', 'pending_approval') AND current_setting('qsell.po_amend', true) IS DISTINCT FROM 'on'
     AND (NEW.vendor_id <> OLD.vendor_id OR NEW.currency <> OLD.currency OR NEW.total <> OLD.total OR NEW.subtotal <> OLD.subtotal
          OR NEW.tax_total <> OLD.tax_total OR NEW.requires_advance_payment <> OLD.requires_advance_payment OR NEW.category_id <> OLD.category_id) THEN
    RAISE EXCEPTION 'a released purchase order changes only through an amendment' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER purchase_orders_guard BEFORE UPDATE OR DELETE ON "purchase_orders" FOR EACH ROW EXECUTE FUNCTION po_guard_header();
