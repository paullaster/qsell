CREATE TABLE "delivery_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"disposition" text NOT NULL,
	"location_id" uuid,
	"note" text,
	"received_by" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_returns_quantity_chk" CHECK ("delivery_returns"."quantity" >= 0),
	CONSTRAINT "delivery_returns_disposition_chk" CHECK ("delivery_returns"."disposition" IN ('restock','damaged','keep'))
);
--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD COLUMN "issued" numeric(14, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_settings" ADD COLUMN "issue_moment" text DEFAULT 'payment' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_returns" ADD CONSTRAINT "delivery_returns_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_returns" ADD CONSTRAINT "delivery_returns_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_returns" ADD CONSTRAINT "delivery_returns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_returns" ADD CONSTRAINT "delivery_returns_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_returns_delivery_product_uidx" ON "delivery_returns" USING btree ("delivery_id","product_id");--> statement-breakpoint
CREATE INDEX "delivery_returns_company_idx" ON "delivery_returns" USING btree ("company_id","received_at");--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_issued_chk" CHECK ("delivery_lines"."issued" >= 0 AND "delivery_lines"."issued" <= COALESCE("delivery_lines"."picked", "delivery_lines"."quantity"));--> statement-breakpoint
ALTER TABLE "stock_settings" ADD CONSTRAINT "stock_settings_issue_moment_chk" CHECK ("stock_settings"."issue_moment" IN ('payment','dispatch','delivery'));--> statement-breakpoint
-- A return receipt is kept: what came back and what was done with it is never changed or removed.
CREATE FUNCTION delivery_returns_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a return receipt is kept; it cannot be changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER delivery_returns_no_change BEFORE UPDATE OR DELETE ON "delivery_returns" FOR EACH ROW EXECUTE FUNCTION delivery_returns_guard();
