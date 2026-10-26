CREATE TABLE "purchase_return_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_return_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"return_id" uuid NOT NULL,
	"event" text NOT NULL,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"rgn_line_id" uuid NOT NULL,
	"po_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 4),
	CONSTRAINT "purchase_return_lines_qty_chk" CHECK ("purchase_return_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"rgn_id" uuid NOT NULL,
	"po_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"return_date" date NOT NULL,
	"reason" text NOT NULL,
	"notes" text,
	"vendor_reference" text,
	"created_by" text,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_returns_status_chk" CHECK ("purchase_returns"."status" IN ('draft','posted','cancelled')),
	CONSTRAINT "purchase_returns_poster_chk" CHECK ("purchase_returns"."posted_by" IS NULL OR "purchase_returns"."posted_by" IS DISTINCT FROM "purchase_returns"."created_by"),
	CONSTRAINT "purchase_returns_posted_chk" CHECK ("purchase_returns"."status" <> 'posted' OR ("purchase_returns"."number" IS NOT NULL AND "purchase_returns"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "rgn_lines" ADD COLUMN "returned_quantity" numeric(14, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_return_events" ADD CONSTRAINT "purchase_return_events_return_id_purchase_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."purchase_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_return_id_purchase_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."purchase_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_rgn_line_id_rgn_lines_id_fk" FOREIGN KEY ("rgn_line_id") REFERENCES "public"."rgn_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_po_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_rgn_id_rgns_id_fk" FOREIGN KEY ("rgn_id") REFERENCES "public"."rgns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_return_events_idx" ON "purchase_return_events" USING btree ("return_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_return_lines_uidx" ON "purchase_return_lines" USING btree ("return_id","rgn_line_id");--> statement-breakpoint
CREATE INDEX "purchase_return_lines_rgn_line_idx" ON "purchase_return_lines" USING btree ("rgn_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_returns_company_number_uidx" ON "purchase_returns" USING btree ("company_id","number") WHERE "purchase_returns"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "purchase_returns_rgn_idx" ON "purchase_returns" USING btree ("rgn_id");--> statement-breakpoint
CREATE INDEX "purchase_returns_vendor_idx" ON "purchase_returns" USING btree ("vendor_id","created_at");--> statement-breakpoint
ALTER TABLE "rgn_lines" ADD CONSTRAINT "rgn_lines_returned_chk" CHECK ("rgn_lines"."returned_quantity" >= 0 AND "rgn_lines"."returned_quantity" + "rgn_lines"."invoiced_quantity" <= "rgn_lines"."accepted");--> statement-breakpoint
CREATE TRIGGER purchase_return_events_append_only BEFORE UPDATE OR DELETE ON "purchase_return_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- A posted return took goods out of stock: it is a record, never changed or deleted.
CREATE FUNCTION purchase_return_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'a posted purchase return cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('posted', 'cancelled') AND (NEW.status <> OLD.status OR NEW.rgn_id <> OLD.rgn_id OR NEW.vendor_id <> OLD.vendor_id OR NEW.return_date <> OLD.return_date
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.reason <> OLD.reason) THEN
    RAISE EXCEPTION 'a posted or cancelled purchase return cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER purchase_returns_guard BEFORE UPDATE OR DELETE ON "purchase_returns" FOR EACH ROW EXECUTE FUNCTION purchase_return_guard();--> statement-breakpoint
CREATE FUNCTION purchase_return_guard_lines() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM purchase_returns WHERE id = COALESCE(NEW.return_id, OLD.return_id);
  IF st IS NOT NULL AND st <> 'draft' AND NOT (TG_OP = 'UPDATE' AND st = 'posted' AND OLD.unit_cost IS NULL AND NEW.unit_cost IS NOT NULL AND NEW.quantity = OLD.quantity AND NEW.rgn_line_id = OLD.rgn_line_id) THEN
    RAISE EXCEPTION 'the lines of a posted purchase return cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER purchase_return_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "purchase_return_lines" FOR EACH ROW EXECUTE FUNCTION purchase_return_guard_lines();
