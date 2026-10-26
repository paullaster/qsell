CREATE TABLE "newsletter_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	CONSTRAINT "newsletter_subscribers_status_chk" CHECK ("newsletter_subscribers"."status" IN ('pending', 'subscribed', 'unsubscribed')),
	CONSTRAINT "newsletter_subscribers_email_chk" CHECK ("newsletter_subscribers"."email" = lower(btrim("newsletter_subscribers"."email")) AND char_length("newsletter_subscribers"."email") BETWEEN 3 AND 254)
);
--> statement-breakpoint
CREATE TABLE "product_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" text NOT NULL,
	"reviewer_key" text NOT NULL,
	"reviewer_name" text NOT NULL,
	"rating" smallint NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_purchase" boolean DEFAULT false NOT NULL,
	"order_id" text,
	"moderation_note" text DEFAULT '' NOT NULL,
	"moderated_by" text,
	"moderated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_reviews_rating_chk" CHECK ("product_reviews"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "product_reviews_status_chk" CHECK ("product_reviews"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "product_reviews_body_chk" CHECK (char_length(btrim("product_reviews"."body")) BETWEEN 10 AND 2000),
	CONSTRAINT "product_reviews_title_chk" CHECK (char_length("product_reviews"."title") <= 100)
);
--> statement-breakpoint
CREATE TABLE "wishlist_items" (
	"user_id" text NOT NULL,
	"product_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wishlist_items_user_id_product_id_pk" PRIMARY KEY("user_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "product_reviews" ADD CONSTRAINT "product_reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_subscribers_email_uidx" ON "newsletter_subscribers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_subscribers_token_uidx" ON "newsletter_subscribers" USING btree ("token");--> statement-breakpoint
CREATE INDEX "newsletter_subscribers_status_idx" ON "newsletter_subscribers" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_reviews_one_per_person_uidx" ON "product_reviews" USING btree ("product_id","reviewer_key");--> statement-breakpoint
CREATE INDEX "product_reviews_public_idx" ON "product_reviews" USING btree ("product_id","created_at","id") WHERE "product_reviews"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "product_reviews_queue_idx" ON "product_reviews" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "product_reviews_reviewer_idx" ON "product_reviews" USING btree ("reviewer_key");--> statement-breakpoint
CREATE INDEX "wishlist_items_user_idx" ON "wishlist_items" USING btree ("user_id","created_at");