ALTER TABLE "van_visits" ADD COLUMN "device_arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "van_visits" ADD COLUMN "arrived_latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "van_visits" ADD COLUMN "arrived_longitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "van_visits" ADD COLUMN "arrived_distance_m" integer;--> statement-breakpoint
ALTER TABLE "van_visits" ADD CONSTRAINT "van_visits_position_chk" CHECK (("van_visits"."arrived_latitude" IS NULL) = ("van_visits"."arrived_longitude" IS NULL));--> statement-breakpoint
ALTER TABLE "van_visits" ADD CONSTRAINT "van_visits_distance_chk" CHECK ("van_visits"."arrived_distance_m" IS NULL OR "van_visits"."arrived_distance_m" >= 0);--> statement-breakpoint
ALTER TABLE "van_visits" ADD CONSTRAINT "van_visits_no_sale_chk" CHECK ("van_visits"."outcome" IS DISTINCT FROM 'no_sale' OR ("van_visits"."no_sale_reason" IS NOT NULL AND length(btrim("van_visits"."no_sale_reason")) > 0));