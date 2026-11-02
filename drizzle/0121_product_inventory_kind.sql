ALTER TABLE "products" ADD COLUMN "inventory_kind" text DEFAULT 'inventory' NOT NULL;--> statement-breakpoint
CREATE INDEX "products_inventory_kind_idx" ON "products" USING btree ("inventory_kind","id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_inventory_kind_chk" CHECK ("products"."inventory_kind" IN ('inventory','non_inventory','service') AND ("products"."inventory_kind" = 'inventory' OR ("products"."stock_quantity" = 0 AND "products"."reserved_quantity" = 0 AND "products"."low_stock_threshold" = 0)));
--> statement-breakpoint
CREATE FUNCTION products_inventory_kind_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inventory_kind IS DISTINCT FROM OLD.inventory_kind THEN
    -- Upgrade the row lock so document inserts holding the FK key-share lock cannot race this history check.
    PERFORM 1 FROM products WHERE id = OLD.id FOR UPDATE;
    IF OLD.stock_quantity <> 0 OR OLD.reserved_quantity <> 0
      OR EXISTS (SELECT 1 FROM inventory_movements WHERE product_id = OLD.id AND (change_amount <> 0 OR change_type <> 'restock'))
      OR EXISTS (SELECT 1 FROM stock_movements WHERE product_id = OLD.id)
      OR EXISTS (SELECT 1 FROM stock_reservations WHERE product_id = OLD.id)
      OR EXISTS (SELECT 1 FROM order_items WHERE product_id = OLD.id)
      OR EXISTS (SELECT 1 FROM purchase_order_lines WHERE product_id = OLD.id)
      OR EXISTS (SELECT 1 FROM sales_quote_lines WHERE product_id = OLD.id)
      OR EXISTS (SELECT 1 FROM sales_quote_template_lines WHERE product_id = OLD.id)
      OR EXISTS (SELECT 1 FROM sales_section_template_lines WHERE product_id = OLD.id)
      OR EXISTS (SELECT 1 FROM stock_document_lines WHERE product_id = OLD.id)
      OR EXISTS (SELECT 1 FROM product_kit_components WHERE product_id = OLD.id) THEN
      RAISE EXCEPTION 'a product with stock or document history cannot change inventory treatment; create a replacement product' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER products_inventory_kind_immutable BEFORE UPDATE OF inventory_kind ON products FOR EACH ROW EXECUTE FUNCTION products_inventory_kind_immutable();
