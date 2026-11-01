ALTER TABLE "branches" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "pin_label" text;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "pin_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "pin_set_by" text;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_pin_chk" CHECK (("branches"."latitude" IS NULL) = ("branches"."longitude" IS NULL) AND ("branches"."latitude" IS NULL OR ("branches"."latitude" BETWEEN -90 AND 90 AND "branches"."longitude" BETWEEN -180 AND 180)));