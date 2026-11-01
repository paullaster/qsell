CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"location_id" uuid NOT NULL,
	"shard" smallint DEFAULT 0 NOT NULL,
	"purpose" text DEFAULT 'order_line' NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"ref_line_id" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"consumed" numeric(14, 3) DEFAULT 0 NOT NULL,
	"released" numeric(14, 3) DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone,
	"sourcing" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"actor" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_reservations_state_chk" CHECK ("stock_reservations"."state" IN ('held','partly_consumed','consumed','released','expired')),
	CONSTRAINT "stock_reservations_quantity_chk" CHECK ("stock_reservations"."quantity" > 0 AND "stock_reservations"."consumed" >= 0 AND "stock_reservations"."released" >= 0 AND "stock_reservations"."consumed" + "stock_reservations"."released" <= "stock_reservations"."quantity")
);
--> statement-breakpoint
ALTER TABLE "stock_settings" ADD COLUMN "ledger_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_settings" ADD COLUMN "unpaid_hold_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_reservations_open_uidx" ON "stock_reservations" USING btree ("ref_type","ref_id","ref_line_id","product_id","location_id","shard") WHERE "stock_reservations"."state" IN ('held','partly_consumed');--> statement-breakpoint
CREATE INDEX "stock_reservations_ref_idx" ON "stock_reservations" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_expiry_idx" ON "stock_reservations" USING btree ("expires_at") WHERE "stock_reservations"."state" IN ('held','partly_consumed') AND "stock_reservations"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_reservations_balance_idx" ON "stock_reservations" USING btree ("product_id","location_id","shard") WHERE "stock_reservations"."state" IN ('held','partly_consumed');--> statement-breakpoint
-- In ledger mode the product's two counters are a maintained total of its balances (design §10 step 3), so every reader that still
-- reads them stays right. Off, this does nothing.
CREATE FUNCTION stock_project_to_product() RETURNS trigger AS $$
DECLARE
  on_ boolean;
  total_on numeric(14,3);
  total_res numeric(14,3);
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER stock_balances_to_product AFTER INSERT OR UPDATE OF on_hand, reserved ON "stock_balances" FOR EACH ROW EXECUTE FUNCTION stock_project_to_product();
