ALTER TABLE "delivery_returns" DROP CONSTRAINT "delivery_returns_disposition_chk";--> statement-breakpoint
-- Receipts already made are put into the shared words (the finance returns use them). The trigger that keeps receipts is lifted for this one rewrite of words and put back.
ALTER TABLE "delivery_returns" DISABLE TRIGGER delivery_returns_no_change;--> statement-breakpoint
UPDATE "delivery_returns" SET "disposition" = CASE "disposition" WHEN 'restock' THEN 'return_to_stock' WHEN 'damaged' THEN 'scrap' ELSE "disposition" END;--> statement-breakpoint
ALTER TABLE "delivery_returns" ENABLE TRIGGER delivery_returns_no_change;--> statement-breakpoint
DROP INDEX "delivery_returns_delivery_product_uidx";--> statement-breakpoint
ALTER TABLE "delivery_returns" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_returns" ADD COLUMN "correction_reason" text;--> statement-breakpoint
ALTER TABLE "delivery_returns" ADD COLUMN "effects" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_returns_delivery_product_rev_uidx" ON "delivery_returns" USING btree ("delivery_id","product_id","revision");--> statement-breakpoint
ALTER TABLE "delivery_returns" ADD CONSTRAINT "delivery_returns_revision_chk" CHECK ("delivery_returns"."revision" >= 1 AND ("delivery_returns"."revision" = 1 OR "delivery_returns"."correction_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "delivery_returns" ADD CONSTRAINT "delivery_returns_disposition_chk" CHECK ("delivery_returns"."disposition" IN ('return_to_stock','quarantine','scrap','keep'));