ALTER TABLE "delivery_text_settings" DROP CONSTRAINT "delivery_text_settings_kinds_chk";--> statement-breakpoint
ALTER TABLE "delivery_text_settings" ALTER COLUMN "kinds" SET DEFAULT '{out_for_delivery,delivered,attempt_failed,ready_for_collection,collection_reminder}'::text[];--> statement-breakpoint
ALTER TABLE "delivery_text_settings" ADD CONSTRAINT "delivery_text_settings_kinds_chk" CHECK ("delivery_text_settings"."kinds" <@ ARRAY['out_for_delivery','delivered','part_delivered','attempt_failed','returned','slot_not_kept','ready_for_collection','collection_reminder']::text[]);
--> statement-breakpoint
-- Until now the reminder was texted whenever "Ready to collect" was: keep that for companies that already chose it.
UPDATE "delivery_text_settings" SET "kinds" = array_append("kinds", 'collection_reminder') WHERE 'ready_for_collection' = ANY("kinds") AND NOT ('collection_reminder' = ANY("kinds"));
