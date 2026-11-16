CREATE TABLE "order_visit_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"media_id" text NOT NULL,
	"kind" text NOT NULL,
	"caption" text,
	"taken_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_visit_photos_kind_chk" CHECK ("order_visit_photos"."kind" IN ('before','after','other')),
	CONSTRAINT "order_visit_photos_caption_chk" CHECK ("order_visit_photos"."caption" IS NULL OR char_length("order_visit_photos"."caption") <= 200)
);
--> statement-breakpoint
ALTER TABLE "order_visit_photos" ADD CONSTRAINT "order_visit_photos_visit_id_order_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."order_visits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_visit_photos" ADD CONSTRAINT "order_visit_photos_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_visit_photos_visit_idx" ON "order_visit_photos" USING btree ("visit_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "order_visit_photos_media_uidx" ON "order_visit_photos" USING btree ("media_id");