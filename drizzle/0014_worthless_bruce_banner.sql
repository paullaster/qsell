ALTER TABLE "sales_quote_templates" ALTER COLUMN "show_billing_address" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "sales_quotes" ALTER COLUMN "show_billing_address" SET DEFAULT false;--> statement-breakpoint
UPDATE "sales_quote_lines" SET "section_id" = NULL WHERE "section_id" IN (SELECT "id" FROM "sales_quote_sections" WHERE lower("title") = 'items' AND coalesce("description", '') = '');--> statement-breakpoint
UPDATE "sales_quote_template_lines" SET "section_id" = NULL WHERE "section_id" IN (SELECT "id" FROM "sales_quote_template_sections" WHERE lower("title") = 'items' AND coalesce("description", '') = '');--> statement-breakpoint
DELETE FROM "sales_quote_sections" WHERE lower("title") = 'items' AND coalesce("description", '') = '';--> statement-breakpoint
DELETE FROM "sales_quote_template_sections" WHERE lower("title") = 'items' AND coalesce("description", '') = '';--> statement-breakpoint
UPDATE "sales_quote_templates" SET "show_billing_address" = false;--> statement-breakpoint
UPDATE "sales_quotes" SET "show_billing_address" = false;
