CREATE TABLE "rgn_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rgn_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"delivered" numeric(14, 3) NOT NULL,
	"accepted" numeric(14, 3) NOT NULL,
	"rejected" numeric(14, 3) DEFAULT '0' NOT NULL,
	"reject_reason" text,
	"unit_cost" numeric(14, 4),
	"invoiced_quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "rgn_lines_qty_chk" CHECK ("rgn_lines"."delivered" > 0 AND "rgn_lines"."accepted" >= 0 AND "rgn_lines"."rejected" >= 0 AND "rgn_lines"."accepted" + "rgn_lines"."rejected" = "rgn_lines"."delivered"),
	CONSTRAINT "rgn_lines_reason_chk" CHECK ("rgn_lines"."rejected" = 0 OR "rgn_lines"."reject_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "rgns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"po_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"received_date" date NOT NULL,
	"delivery_note_no" text NOT NULL,
	"vehicle" text,
	"notes" text,
	"received_by" text,
	"created_by" text,
	"posted_at" timestamp with time zone,
	"posted_by" text,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	"reverse_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rgns_status_chk" CHECK ("rgns"."status" IN ('draft','posted','reversed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "vendor_settings" ADD COLUMN "receipt_tolerance_percent" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "rgn_lines" ADD CONSTRAINT "rgn_lines_rgn_id_rgns_id_fk" FOREIGN KEY ("rgn_id") REFERENCES "public"."rgns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rgn_lines" ADD CONSTRAINT "rgn_lines_po_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rgns" ADD CONSTRAINT "rgns_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rgns" ADD CONSTRAINT "rgns_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rgns" ADD CONSTRAINT "rgns_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rgn_lines_rgn_idx" ON "rgn_lines" USING btree ("rgn_id");--> statement-breakpoint
CREATE INDEX "rgn_lines_po_line_idx" ON "rgn_lines" USING btree ("po_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rgn_lines_uidx" ON "rgn_lines" USING btree ("rgn_id","po_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rgns_company_number_uidx" ON "rgns" USING btree ("company_id","number") WHERE "rgns"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rgns_delivery_note_uidx" ON "rgns" USING btree ("vendor_id",lower("delivery_note_no")) WHERE "rgns"."status" = 'posted';--> statement-breakpoint
CREATE INDEX "rgns_po_idx" ON "rgns" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "rgns_company_status_idx" ON "rgns" USING btree ("company_id","status","created_at");--> statement-breakpoint
-- A posted received goods note is a record of what arrived. Only its own reversal may change it, and its lines never change
-- (the invoiced counter, kept by supplier invoices, is the one thing that moves).
CREATE FUNCTION rgn_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a posted received goods note cannot be deleted; reverse it' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('posted', 'reversed') AND (NEW.po_id <> OLD.po_id OR NEW.vendor_id <> OLD.vendor_id OR NEW.received_date <> OLD.received_date
     OR NEW.delivery_note_no <> OLD.delivery_note_no OR NEW.number IS DISTINCT FROM OLD.number) THEN
    RAISE EXCEPTION 'a posted received goods note cannot be changed; reverse it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('reversed', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'this received goods note is finished' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER rgns_guard BEFORE UPDATE OR DELETE ON "rgns" FOR EACH ROW EXECUTE FUNCTION rgn_guard();--> statement-breakpoint
CREATE FUNCTION rgn_guard_lines() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.rgn_id = OLD.rgn_id AND NEW.po_line_id = OLD.po_line_id AND NEW.delivered = OLD.delivered AND NEW.accepted = OLD.accepted
     AND NEW.rejected = OLD.rejected AND NEW.reject_reason IS NOT DISTINCT FROM OLD.reject_reason AND NEW.unit_cost IS NOT DISTINCT FROM OLD.unit_cost THEN
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM rgns WHERE id = COALESCE(NEW.rgn_id, OLD.rgn_id);
  IF st IS NOT NULL AND st <> 'draft' AND NOT (TG_OP = 'UPDATE' AND st = 'posted' AND OLD.unit_cost IS NULL AND NEW.unit_cost IS NOT NULL
     AND NEW.delivered = OLD.delivered AND NEW.accepted = OLD.accepted AND NEW.rejected = OLD.rejected) THEN
    RAISE EXCEPTION 'the lines of a posted received goods note cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER rgn_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "rgn_lines" FOR EACH ROW EXECUTE FUNCTION rgn_guard_lines();
