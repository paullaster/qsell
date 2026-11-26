-- The name the installed app goes by. The same change was first made as 0212_pwa_app_name on main, so a database that already has it
-- must not fail here: every statement checks first.
ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "app_name" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "app_short_name" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_settings_app_name_chk') THEN
    ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_app_name_chk" CHECK (("company_settings"."app_name" IS NULL OR char_length("company_settings"."app_name") BETWEEN 1 AND 45) AND ("company_settings"."app_short_name" IS NULL OR char_length("company_settings"."app_short_name") BETWEEN 1 AND 12));
  END IF;
END $$;
