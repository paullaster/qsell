CREATE INDEX "company_settings_active_updated_idx" ON "company_settings" USING btree ("updated_at" DESC NULLS LAST) WHERE "company_settings"."is_active";--> statement-breakpoint
