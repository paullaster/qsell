ALTER TABLE "package_instances" ADD COLUMN "note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_slots" ADD COLUMN "source" text DEFAULT 'list' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_slots" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "package_slots" ADD COLUMN "category_difference" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "package_slots" ADD COLUMN "category_own_price" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "package_slots" ADD COLUMN "category_quantity" numeric(14, 3) DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_packages" ADD COLUMN "allow_note" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "package_slots" ADD CONSTRAINT "package_slots_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "package_slots_category_idx" ON "package_slots" USING btree ("category_id");--> statement-breakpoint
ALTER TABLE "package_slots" ADD CONSTRAINT "package_slots_source_chk" CHECK ("package_slots"."source" IN ('list', 'category') AND ("package_slots"."source" = 'list' OR "package_slots"."category_id" IS NOT NULL) AND "package_slots"."category_quantity" > 0);