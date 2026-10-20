ALTER TABLE "order_items" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "unit_code" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "entered_quantity" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "qty_per_unit" numeric(24, 10);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "entered_unit_price" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "unit_code" text;--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "entered_quantity" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "qty_per_unit" numeric(24, 10);--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "entered_unit_price" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_unit_id_units_of_measure_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD CONSTRAINT "sales_quote_lines_unit_id_units_of_measure_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_items_unit_idx" ON "order_items" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "sales_quote_lines_unit_idx" ON "sales_quote_lines" USING btree ("unit_id");