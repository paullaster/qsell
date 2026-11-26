ALTER TABLE "van_loads" DROP CONSTRAINT "van_loads_kind_chk";--> statement-breakpoint
CREATE UNIQUE INDEX "van_loads_day_unload_uidx" ON "van_loads" USING btree ("day_id") WHERE "van_loads"."kind" = 'unload' AND "van_loads"."cancelled_at" IS NULL;--> statement-breakpoint
ALTER TABLE "van_loads" ADD CONSTRAINT "van_loads_kind_chk" CHECK ("van_loads"."kind" IN ('load','top_up','unload'));