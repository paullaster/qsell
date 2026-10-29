CREATE TABLE "stock_balances" (
	"company_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"location_id" uuid NOT NULL,
	"shard" smallint DEFAULT 0 NOT NULL,
	"on_hand" numeric(14, 3) DEFAULT 0 NOT NULL,
	"reserved" numeric(14, 3) DEFAULT 0 NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_product_id_location_id_shard_pk" PRIMARY KEY("product_id","location_id","shard"),
	CONSTRAINT "stock_balances_reserved_chk" CHECK ("stock_balances"."reserved" >= 0),
	CONSTRAINT "stock_balances_shard_chk" CHECK ("stock_balances"."shard" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'warehouse' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"is_sellable" boolean DEFAULT true NOT NULL,
	"sells_channels" text[] DEFAULT ARRAY['ecommerce','sales_order','credit_sale','pos_cash_sale']::text[] NOT NULL,
	"fulfils_delivery" boolean DEFAULT true NOT NULL,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_locations_kind_chk" CHECK ("stock_locations"."kind" IN ('warehouse','store','van','quarantine','damaged','consignment_in','transit')),
	CONSTRAINT "stock_locations_default_active_chk" CHECK (NOT "stock_locations"."is_default" OR "stock_locations"."is_active")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"location_id" uuid NOT NULL,
	"shard" smallint DEFAULT 0 NOT NULL,
	"movement_type" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 4) DEFAULT '0' NOT NULL,
	"document_type" text,
	"document_id" text,
	"document_line_id" text,
	"reason_code" text,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"correlation_id" text,
	"note" text DEFAULT '' NOT NULL,
	"legacy_movement_id" text,
	"migrated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "stock_movements_type_chk" CHECK ("stock_movements"."movement_type" IN ('receipt','purchase_return','receipt_reversal','sale_issue','sale_return','transfer_out','transfer_in','adjustment','count_variance','write_off','opening','delete_adjust','cost_revaluation')),
	CONSTRAINT "stock_movements_quantity_chk" CHECK ("stock_movements"."quantity" <> 0 OR "stock_movements"."movement_type" = 'cost_revaluation')
);
--> statement-breakpoint
CREATE TABLE "stock_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"shadow_write" boolean DEFAULT false NOT NULL,
	"backfill_cursor" text,
	"backfill_done_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_settings" ADD CONSTRAINT "stock_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_balances_location_idx" ON "stock_balances" USING btree ("location_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_locations_company_code_uidx" ON "stock_locations" USING btree ("company_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "stock_locations_one_default_uidx" ON "stock_locations" USING btree ("company_id") WHERE "stock_locations"."is_default";--> statement-breakpoint
CREATE INDEX "stock_locations_branch_idx" ON "stock_locations" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "stock_movements_product_idx" ON "stock_movements" USING btree ("product_id","location_id","id");--> statement-breakpoint
CREATE INDEX "stock_movements_document_idx" ON "stock_movements" USING btree ("document_type","document_id");--> statement-breakpoint
CREATE INDEX "stock_movements_occurred_idx" ON "stock_movements" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movements_company_idx" ON "stock_movements" USING btree ("company_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_legacy_uidx" ON "stock_movements" USING btree ("legacy_movement_id") WHERE "stock_movements"."legacy_movement_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_document_line_uidx" ON "stock_movements" USING btree ("document_type","document_id","document_line_id","product_id","movement_type","location_id") WHERE "stock_movements"."document_line_id" IS NOT NULL;--> statement-breakpoint
-- The movement ledger is append-only: a mistake is corrected by another movement, never by an edit.
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON "stock_movements" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- Each company starts with one location, "Main stock", and a settings row with the shadow switched off.
INSERT INTO "stock_locations" ("company_id", "code", "name", "kind", "is_default")
SELECT c.id, 'MAIN', 'Main stock', 'warehouse', true FROM "company_settings" c
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "stock_settings" ("company_id") SELECT c.id FROM "company_settings" c ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The default location, made on the spot if a company that was set up later has none yet.
CREATE FUNCTION stock_default_location(OUT loc uuid, OUT comp uuid) AS $$
BEGIN
  SELECT l.id, l.company_id INTO loc, comp FROM stock_locations l WHERE l.is_default AND l.is_active LIMIT 1;
  IF loc IS NULL THEN
    SELECT c.id INTO comp FROM company_settings c ORDER BY c.created_at LIMIT 1;
    IF comp IS NOT NULL THEN
      INSERT INTO stock_locations (company_id, code, name, kind, is_default) VALUES (comp, 'MAIN', 'Main stock', 'warehouse', true)
      ON CONFLICT DO NOTHING;
      SELECT l.id, l.company_id INTO loc, comp FROM stock_locations l WHERE l.is_default AND l.is_active LIMIT 1;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- What the old journal calls a change of stock, in the ledger's words. Used by the shadow and by the backfill.
CREATE FUNCTION stock_movement_kind(change_type text) RETURNS text AS $$
  SELECT CASE change_type
    WHEN 'order_fulfillment' THEN 'sale_issue'
    WHEN 'purchase_order_receipt' THEN 'receipt'
    WHEN 'restock' THEN 'receipt'
    WHEN 'purchase_receipt_reversal' THEN 'receipt_reversal'
    WHEN 'purchase_return' THEN 'purchase_return'
    WHEN 'credit_note_restock' THEN 'sale_return'
    WHEN 'manual_adjustment' THEN 'adjustment'
    WHEN 'physical_audit' THEN 'count_variance'
    WHEN 'damage_writeoff' THEN 'write_off'
    WHEN 'product_deleted' THEN 'delete_adjust'
    WHEN 'product_restored' THEN 'delete_adjust'
    ELSE 'adjustment'
  END
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint
-- Shadow of the migration (design §10 step 2): while the switch is on, every journal row that moved physical stock is also a movement
-- at the default location and changes its balance. A mirror that fails must never stop a sale, so a failure is a warning here and the
-- comparison job reports the difference. The old journal writes stay the source of truth until the cut-over.
CREATE FUNCTION stock_mirror_journal() RETURNS trigger AS $$
DECLARE
  on_ boolean;
  loc uuid;
  comp uuid;
  qty numeric(14,3);
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
  SELECT shadow_write INTO on_ FROM stock_settings LIMIT 1;
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER inventory_movements_to_stock AFTER INSERT ON "inventory_movements" FOR EACH ROW EXECUTE FUNCTION stock_mirror_journal();--> statement-breakpoint
-- Holds are not in the journal as quantities, so the shadow follows the product's reserved counter itself.
CREATE FUNCTION stock_mirror_reserved() RETURNS trigger AS $$
DECLARE
  on_ boolean;
  loc uuid;
  comp uuid;
BEGIN
  SELECT shadow_write INTO on_ FROM stock_settings LIMIT 1;
  IF on_ IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  BEGIN
    SELECT d.loc, d.comp INTO loc, comp FROM stock_default_location() d;
    IF loc IS NULL THEN
      RAISE WARNING 'stock shadow: no default location for product %', NEW.id;
      RETURN NEW;
    END IF;
    INSERT INTO stock_balances (company_id, product_id, location_id, shard, on_hand, reserved, version)
    VALUES (comp, NEW.id, loc, 0, 0, GREATEST(NEW.reserved_quantity - OLD.reserved_quantity, 0), 1)
    ON CONFLICT (product_id, location_id, shard)
    DO UPDATE SET reserved = GREATEST(stock_balances.reserved + (NEW.reserved_quantity - OLD.reserved_quantity), 0), version = stock_balances.version + 1, updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'stock shadow: reserved change of product % not mirrored: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER products_reserved_to_stock AFTER UPDATE OF reserved_quantity ON "products" FOR EACH ROW WHEN (OLD.reserved_quantity IS DISTINCT FROM NEW.reserved_quantity) EXECUTE FUNCTION stock_mirror_reserved();
