ALTER TABLE "products" ADD COLUMN "show_on_web_shop" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- A product keeps a copy of its business classification's "sold to customers" answer (its name and code are read from the classification
-- itself). The copy is kept in step by the database, in the same transaction as the change, so no way of editing a classification
-- (a screen, an import, a script) can leave it behind.
CREATE FUNCTION "item_types_cascade"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  packaging_count integer;
BEGIN
  IF NEW.is_sellable IS DISTINCT FROM OLD.is_sellable AND NEW.is_sellable = false THEN
    SELECT count(*) INTO packaging_count FROM products
      WHERE item_type_id = NEW.id AND is_checkout_packaging = true AND is_active = true AND deleted_at IS NULL;
    IF packaging_count > 0 THEN
      RAISE EXCEPTION 'item_type_in_use_as_packaging: % product(s) of this classification are offered as checkout packaging', packaging_count
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.is_sellable IS DISTINCT FROM OLD.is_sellable THEN
    -- Sold only when the classification says so and there is a selling price to sell at.
    UPDATE products SET is_sellable = (NEW.is_sellable AND coalesce(price, 0) > 0), updated_at = now()
      WHERE item_type_id = NEW.id AND is_sellable IS DISTINCT FROM (NEW.is_sellable AND coalesce(price, 0) > 0);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "item_types_cascade_trg" AFTER UPDATE ON "item_types"
  FOR EACH ROW EXECUTE FUNCTION "item_types_cascade"();
--> statement-breakpoint
-- One-time repair of products already out of step with their classification (editing a classification never reached them before).
-- A product that becomes sold only now is not shown in the web shop until someone chooses to, so nothing new appears online by surprise.
UPDATE "products" p SET
    "show_on_web_shop" = CASE WHEN NOT p."is_sellable" AND t."is_sellable" AND coalesce(p."price", 0) > 0 THEN false ELSE p."show_on_web_shop" END,
    "is_sellable" = (t."is_sellable" AND coalesce(p."price", 0) > 0)
  FROM "item_types" t
  WHERE t."id" = p."item_type_id"
    AND p."is_sellable" IS DISTINCT FROM (t."is_sellable" AND coalesce(p."price", 0) > 0);
