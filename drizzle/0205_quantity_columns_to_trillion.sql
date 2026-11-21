-- Hand-edited: two triggers name the columns being widened (UPDATE OF ...), and Postgres will not change the type of a column a
-- trigger definition uses, so they are dropped here and recreated unchanged below. Three trigger functions declare their working
-- variables as numeric(14,3); they are replaced with numeric(16,3) so a quantity up to 1,000,000,000,000 passes through them.
DROP TRIGGER "products_reserved_to_stock" ON "products";
--> statement-breakpoint
DROP TRIGGER "stock_balances_to_product" ON "stock_balances";
--> statement-breakpoint
ALTER TABLE "credit_note_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "credit_note_lines" ALTER COLUMN "entered_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "delivery_attempt_lines" ALTER COLUMN "carried" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "delivery_attempt_lines" ALTER COLUMN "accepted" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "delivery_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "delivery_lines" ALTER COLUMN "picked" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "delivery_lines" ALTER COLUMN "delivered" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "delivery_lines" ALTER COLUMN "delivered" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "delivery_lines" ALTER COLUMN "issued" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "delivery_lines" ALTER COLUMN "issued" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "delivery_returns" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "etims_items" ALTER COLUMN "stock_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "finance_inventory_events" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "change_amount" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "previous_stock" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "inventory_movements" ALTER COLUMN "new_stock" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "landed_cost_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "order_billing_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "entered_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "order_visit_materials" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "package_instance_picks" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "package_options" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "package_options" ALTER COLUMN "quantity" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "package_slots" ALTER COLUMN "category_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "package_slots" ALTER COLUMN "category_quantity" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "product_kit_components" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "product_kit_components" ALTER COLUMN "quantity" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "min_order_qty" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "max_order_qty" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "stock_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
DROP TRIGGER IF EXISTS "products_reserved_to_stock" ON "products";--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "reserved_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
CREATE TRIGGER "products_reserved_to_stock" AFTER UPDATE OF reserved_quantity ON "products" FOR EACH ROW WHEN (OLD.reserved_quantity IS DISTINCT FROM NEW.reserved_quantity) EXECUTE FUNCTION stock_mirror_reserved();--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "low_stock_threshold" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "received_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "received_quantity" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "invoiced_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "invoiced_quantity" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "cancelled_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ALTER COLUMN "cancelled_quantity" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "purchase_requisition_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "purchase_return_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "return_receipt_confirmations" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ALTER COLUMN "expected_qty" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ALTER COLUMN "received_qty" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "rfq_awards" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "rfq_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "rfq_quote_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "rgn_lines" ALTER COLUMN "delivered" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "rgn_lines" ALTER COLUMN "accepted" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "rgn_lines" ALTER COLUMN "rejected" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "rgn_lines" ALTER COLUMN "rejected" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "rgn_lines" ALTER COLUMN "invoiced_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "rgn_lines" ALTER COLUMN "invoiced_quantity" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "rgn_lines" ALTER COLUMN "returned_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "rgn_lines" ALTER COLUMN "returned_quantity" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ALTER COLUMN "entered_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "sales_quote_template_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "sales_quote_template_lines" ALTER COLUMN "quantity" SET DEFAULT '1';--> statement-breakpoint
ALTER TABLE "sales_section_template_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "sales_section_template_lines" ALTER COLUMN "quantity" SET DEFAULT '1';--> statement-breakpoint
DROP TRIGGER IF EXISTS "stock_balances_to_product" ON "stock_balances";--> statement-breakpoint
ALTER TABLE "stock_balances" ALTER COLUMN "on_hand" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_balances" ALTER COLUMN "reserved" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
CREATE TRIGGER "stock_balances_to_product" AFTER INSERT OR UPDATE OF on_hand, reserved ON "stock_balances" FOR EACH ROW EXECUTE FUNCTION stock_project_to_product();--> statement-breakpoint
ALTER TABLE "stock_document_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_document_lines" ALTER COLUMN "shipped_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_document_lines" ALTER COLUMN "received_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_document_lines" ALTER COLUMN "written_off_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_document_lines" ALTER COLUMN "returned_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_document_lines" ALTER COLUMN "expected_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_document_lines" ALTER COLUMN "counted_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_document_lines" ALTER COLUMN "variance_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_movements" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_reservations" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_reservations" ALTER COLUMN "consumed" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "stock_reservations" ALTER COLUMN "released" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "supplier_invoice_line_rgn" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "supplier_invoice_matches" ALTER COLUMN "quantity_difference" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "supplier_invoice_matches" ALTER COLUMN "quantity_difference" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "vendor_contract_lines" ALTER COLUMN "max_quantity" SET DATA TYPE numeric(16, 3);--> statement-breakpoint
ALTER TABLE "vendor_credit_memo_lines" ALTER COLUMN "quantity" SET DATA TYPE numeric(16, 3);
--> statement-breakpoint
CREATE TRIGGER products_reserved_to_stock AFTER UPDATE OF reserved_quantity ON public.products FOR EACH ROW WHEN ((old.reserved_quantity IS DISTINCT FROM new.reserved_quantity)) EXECUTE FUNCTION stock_mirror_reserved();
--> statement-breakpoint
CREATE TRIGGER stock_balances_to_product AFTER INSERT OR UPDATE OF on_hand, reserved ON public.stock_balances FOR EACH ROW EXECUTE FUNCTION stock_project_to_product();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.finance_capture_stock_movement()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  s RECORD;
  unit numeric(14,2);
  qty numeric(16,3);
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
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.stock_mirror_journal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  on_ boolean;
  loc uuid;
  comp uuid;
  qty numeric(16,3);
  kind text;
  cost numeric(14,4);
  new_id bigint;
BEGIN
  IF NEW.change_type IN ('order_reservation', 'order_cancellation_release', 'cost_change') THEN
    RETURN NEW;
  END IF;
  qty := NEW.new_stock - NEW.previous_stock;
  IF qty = 0 THEN
    RETURN NEW;
  END IF;
  SELECT shadow_write INTO on_ FROM stock_settings WHERE company_id = stock_current_company();
  IF on_ IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  BEGIN
    kind := stock_movement_kind(NEW.change_type);
    SELECT d.loc, d.comp INTO loc, comp FROM stock_default_location() d;
    IF loc IS NULL THEN
      RAISE WARNING 'stock shadow: no default location for %', NEW.id;
      RETURN NEW;
    END IF;
    SELECT COALESCE(p.cost_price, 0) INTO cost FROM products p WHERE p.id = NEW.product_id;
    INSERT INTO stock_movements (company_id, product_id, location_id, shard, movement_type, quantity, unit_cost, document_type, document_id,
                                 actor_type, occurred_at, note, legacy_movement_id)
    VALUES (comp, NEW.product_id, loc, 0, kind, qty, COALESCE(cost, 0), 'inventory_journal', NEW.reference_id,
            'legacy', NEW.created_at, NEW.note, NEW.id)
    ON CONFLICT (legacy_movement_id) WHERE legacy_movement_id IS NOT NULL DO NOTHING
    RETURNING id INTO new_id;
    IF new_id IS NOT NULL THEN
      INSERT INTO stock_balances (company_id, product_id, location_id, shard, on_hand, reserved, version)
      VALUES (comp, NEW.product_id, loc, 0, qty, 0, 1)
      ON CONFLICT (product_id, location_id, shard)
      DO UPDATE SET on_hand = stock_balances.on_hand + EXCLUDED.on_hand, version = stock_balances.version + 1, updated_at = now();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'stock shadow: journal row % not mirrored: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.stock_project_to_product()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  on_ boolean;
  total_on numeric(16,3);
  total_res numeric(16,3);
BEGIN
  SELECT ledger_mode INTO on_ FROM stock_settings WHERE company_id = stock_current_company();
  IF on_ IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum(on_hand), 0), COALESCE(sum(reserved), 0) INTO total_on, total_res FROM stock_balances WHERE product_id = NEW.product_id;
  UPDATE products SET stock_quantity = total_on, reserved_quantity = total_res, updated_at = now()
  WHERE id = NEW.product_id AND (stock_quantity <> total_on OR reserved_quantity <> total_res);
  RETURN NEW;
END;
$function$;
