ALTER TABLE "product_kit_components" DROP CONSTRAINT "product_kit_components_qty_chk";--> statement-breakpoint
ALTER TABLE "units_of_measure" DROP CONSTRAINT "units_of_measure_decimals_chk";--> statement-breakpoint
ALTER TABLE "credit_note_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "etims_items" ALTER COLUMN "stock_quantity" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "finance_inventory_events" ALTER COLUMN "quantity" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "change_amount" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "previous_stock" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "new_stock" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "product_kit_components" ALTER COLUMN "quantity" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "product_kit_components" ALTER COLUMN "quantity" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "stock_quantity" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "reserved_quantity" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "low_stock_threshold" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "return_receipt_confirmations" ALTER COLUMN "quantity" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ALTER COLUMN "expected_qty" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ALTER COLUMN "received_qty" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "product_kit_components" ADD CONSTRAINT "product_kit_components_qty_chk" CHECK ("product_kit_components"."quantity" > 0);--> statement-breakpoint
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_decimals_chk" CHECK ("units_of_measure"."decimals" BETWEEN 0 AND 3);--> statement-breakpoint
-- The two functions that write stock changes to the books were written for whole units (`qty integer` would round 2.5 kg to 3).
-- They now carry the quantity exactly and round only the money, to cents.
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
    VALUES (s.company_id, 'movement', NEW.id, NEW.product_id, NEW.change_type, qty, COALESCE(unit, 0), round(qty * COALESCE(unit, 0), 2), (NEW.created_at AT TIME ZONE 'Africa/Nairobi')::date)
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
    VALUES (s.company_id, 'revaluation', NEW.id, 'cost_change', OLD.stock_quantity, NEW.cost_price - OLD.cost_price, round(OLD.stock_quantity * (NEW.cost_price - OLD.cost_price), 2), (now() AT TIME ZONE 'Africa/Nairobi')::date);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
