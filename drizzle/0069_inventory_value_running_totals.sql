CREATE TABLE "finance_inventory_totals" (
	"company_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"exact_total" numeric(30, 5) NOT NULL,
	"booked_total" numeric(20, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_inventory_totals_company_id_product_id_pk" PRIMARY KEY("company_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "finance_inventory_totals" ADD CONSTRAINT "finance_inventory_totals_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Writes a change of stock value down as the difference between the rounded running totals of the product, so that the books
-- for a product add up to units x cost to the cent however many fractional changes there have been. The product's row is
-- locked by the change that is being written down, so two changes of one product cannot interleave; the totals row is locked
-- as well. A product with no totals yet starts from what it was worth just before this change.
CREATE OR REPLACE FUNCTION finance_inventory_book(company uuid, product text, before_exact numeric, change_exact numeric) RETURNS numeric AS $$
DECLARE
  t finance_inventory_totals%ROWTYPE;
  next_exact numeric(30,5);
  next_booked numeric(20,2);
BEGIN
  INSERT INTO finance_inventory_totals (company_id, product_id, exact_total, booked_total)
  VALUES (company, product, before_exact, round(before_exact, 2))
  ON CONFLICT (company_id, product_id) DO NOTHING;
  SELECT * INTO t FROM finance_inventory_totals WHERE company_id = company AND product_id = product FOR UPDATE;
  next_exact := t.exact_total + change_exact;
  next_booked := round(next_exact, 2);
  UPDATE finance_inventory_totals SET exact_total = next_exact, booked_total = next_booked, updated_at = now()
   WHERE company_id = company AND product_id = product;
  RETURN next_booked - t.booked_total;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance_capture_stock_movement() RETURNS trigger AS $$
DECLARE
  s RECORD;
  unit numeric(14,2);
  qty numeric(14,3);
BEGIN
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
    VALUES (
      s.company_id, 'movement', NEW.id, NEW.product_id, NEW.change_type, qty, COALESCE(unit, 0),
      finance_inventory_book(s.company_id, NEW.product_id, NEW.previous_stock * COALESCE(unit, 0), qty * COALESCE(unit, 0)),
      (NEW.created_at AT TIME ZONE 'Africa/Nairobi')::date
    )
    ON CONFLICT DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION finance_capture_cost_change() RETURNS trigger AS $$
DECLARE
  s RECORD;
BEGIN
  IF OLD.stock_quantity = 0 THEN
    RETURN NEW;
  END IF;
  FOR s IN SELECT company_id FROM finance_settings WHERE inventory_gl_go_live IS NOT NULL LOOP
    INSERT INTO finance_inventory_events (company_id, kind, product_id, change_type, quantity, unit_cost, value, event_date)
    VALUES (
      s.company_id, 'revaluation', NEW.id, 'cost_change', OLD.stock_quantity, NEW.cost_price - OLD.cost_price,
      finance_inventory_book(s.company_id, NEW.id, OLD.stock_quantity * OLD.cost_price, OLD.stock_quantity * (NEW.cost_price - OLD.cost_price)),
      (now() AT TIME ZONE 'Africa/Nairobi')::date
    );
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
