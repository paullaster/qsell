CREATE TABLE "finance_inventory_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "finance_inventory_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"movement_id" text,
	"product_id" text NOT NULL,
	"change_type" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(14, 2) NOT NULL,
	"value" numeric(20, 2) NOT NULL,
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
ALTER TABLE "finance_settings" ADD COLUMN "inventory_gl_go_live" date;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD COLUMN "inventory_account_id" uuid;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD COLUMN "inventory_clearing_account_id" uuid;--> statement-breakpoint
ALTER TABLE "finance_inventory_events" ADD CONSTRAINT "finance_inventory_events_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_inventory_events_movement_uidx" ON "finance_inventory_events" USING btree ("company_id","movement_id") WHERE "finance_inventory_events"."movement_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "finance_inventory_events_due_idx" ON "finance_inventory_events" USING btree ("next_attempt_at") WHERE "finance_inventory_events"."status" IN ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "finance_inventory_events_status_idx" ON "finance_inventory_events" USING btree ("company_id","status","id");--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_inventory_account_id_gl_accounts_id_fk" FOREIGN KEY ("inventory_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "general_posting_setup" ADD CONSTRAINT "general_posting_setup_inventory_clearing_account_id_gl_accounts_id_fk" FOREIGN KEY ("inventory_clearing_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Every change in what stock is worth is written down by the database the moment it happens, so no way of
-- changing stock (checkout, a purchase receipt, a return, a count, an import) can reach the shelf without
-- reaching the books. Nothing is written until the company has set an inventory go-live date.
CREATE FUNCTION finance_capture_stock_movement() RETURNS trigger AS $$
DECLARE
  s RECORD;
  unit numeric(14,2);
  qty integer;
BEGIN
  -- A reservation holds goods aside and a release lets them go: neither changes what is on hand.
  IF NEW.change_type IN ('order_reservation', 'order_cancellation_release') THEN
    RETURN NEW;
  END IF;
  qty := NEW.new_stock - NEW.previous_stock;
  IF qty = 0 THEN
    RETURN NEW;
  END IF;
  SELECT cost_price INTO unit FROM products WHERE id = NEW.product_id;
  FOR s IN SELECT company_id FROM finance_settings WHERE inventory_gl_go_live IS NOT NULL LOOP
    INSERT INTO finance_inventory_events (company_id, kind, movement_id, product_id, change_type, quantity, unit_cost, value, event_date)
    VALUES (s.company_id, 'movement', NEW.id, NEW.product_id, NEW.change_type, qty, COALESCE(unit, 0), qty * COALESCE(unit, 0), (NEW.created_at AT TIME ZONE 'Africa/Nairobi')::date)
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER inventory_movements_to_books AFTER INSERT ON "inventory_movements" FOR EACH ROW EXECUTE FUNCTION finance_capture_stock_movement();--> statement-breakpoint
-- A change of cost revalues the goods that were in hand before the change (movements after it carry the new cost).
CREATE FUNCTION finance_capture_cost_change() RETURNS trigger AS $$
DECLARE
  s RECORD;
BEGIN
  IF OLD.stock_quantity = 0 THEN
    RETURN NEW;
  END IF;
  FOR s IN SELECT company_id FROM finance_settings WHERE inventory_gl_go_live IS NOT NULL LOOP
    INSERT INTO finance_inventory_events (company_id, kind, product_id, change_type, quantity, unit_cost, value, event_date)
    VALUES (s.company_id, 'revaluation', NEW.id, 'cost_change', OLD.stock_quantity, NEW.cost_price - OLD.cost_price, OLD.stock_quantity * (NEW.cost_price - OLD.cost_price), (now() AT TIME ZONE 'Africa/Nairobi')::date);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER products_cost_to_books AFTER UPDATE OF cost_price ON "products" FOR EACH ROW WHEN (OLD.cost_price IS DISTINCT FROM NEW.cost_price) EXECUTE FUNCTION finance_capture_cost_change();--> statement-breakpoint
-- The record of what reached the books is kept: an event can be retried or skipped, never rewritten or deleted.
CREATE FUNCTION finance_guard_inventory_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory posting events are kept; they cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.kind <> OLD.kind OR NEW.product_id <> OLD.product_id OR NEW.change_type <> OLD.change_type
     OR NEW.quantity <> OLD.quantity OR NEW.unit_cost <> OLD.unit_cost OR NEW.value <> OLD.value OR NEW.event_date <> OLD.event_date
     OR NEW.movement_id IS DISTINCT FROM OLD.movement_id THEN
    RAISE EXCEPTION 'an inventory posting event keeps what happened' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('posted', 'skipped') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % inventory posting event cannot change', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER finance_inventory_events_guard BEFORE UPDATE OR DELETE ON "finance_inventory_events" FOR EACH ROW EXECUTE FUNCTION finance_guard_inventory_event();
