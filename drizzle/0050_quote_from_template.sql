ALTER TABLE "sales_quote_lines" ADD COLUMN "from_template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quote_sections" ADD COLUMN "from_template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Best-effort backfill for quotes saved before these columns: an item or section counts as coming
-- from the template when the quote's template still holds the same product / section title.
UPDATE "sales_quote_lines" l SET "from_template" = true
FROM "sales_quotes" q
WHERE q."id" = l."quote_id" AND q."template_id" IS NOT NULL AND l."is_gift" = false
  AND EXISTS (SELECT 1 FROM "sales_quote_template_lines" tl WHERE tl."template_id" = q."template_id" AND tl."product_id" = l."product_id");--> statement-breakpoint
UPDATE "sales_quote_sections" s SET "from_template" = true
FROM "sales_quotes" q
WHERE q."id" = s."quote_id" AND q."template_id" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "sales_quote_template_sections" ts WHERE ts."template_id" = q."template_id" AND ts."title" = s."title");
