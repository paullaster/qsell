ALTER TABLE "order_items" ADD COLUMN "line_no" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_line_uidx" ON "order_items" USING btree ("order_id","line_no") WHERE "order_items"."line_no" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_line_no_chk" CHECK ("order_items"."line_no" IS NULL OR "order_items"."line_no" > 0);