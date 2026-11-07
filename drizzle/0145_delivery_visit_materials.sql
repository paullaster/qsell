CREATE TABLE "order_visit_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(14, 4) DEFAULT '0' NOT NULL,
	"reverses_id" uuid,
	"note" text,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_visit_materials_qty_chk" CHECK ("order_visit_materials"."quantity" <> 0 AND (("order_visit_materials"."reverses_id" IS NULL) = ("order_visit_materials"."quantity" > 0)))
);
--> statement-breakpoint
ALTER TABLE "order_visit_materials" ADD CONSTRAINT "order_visit_materials_visit_id_order_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."order_visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_visit_materials" ADD CONSTRAINT "order_visit_materials_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_visit_materials" ADD CONSTRAINT "order_visit_materials_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_visit_materials_visit_idx" ON "order_visit_materials" USING btree ("visit_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_visit_materials_reverses_idx" ON "order_visit_materials" USING btree ("reverses_id") WHERE "order_visit_materials"."reverses_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "order_visit_materials" ADD CONSTRAINT "order_visit_materials_reverses_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."order_visit_materials"("id") ON DELETE restrict;--> statement-breakpoint
-- Materials used, and what was given back, are kept for good.
CREATE TRIGGER order_visit_materials_no_change BEFORE UPDATE OR DELETE ON "order_visit_materials" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
