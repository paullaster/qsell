CREATE TABLE "scorecard_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"weight" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scorecard_criteria_source_chk" CHECK ("scorecard_criteria"."source" IN ('on_time','accepted','invoice_accuracy','rfq_response','rating')),
	CONSTRAINT "scorecard_criteria_weight_chk" CHECK ("scorecard_criteria"."weight" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "vendor_review_ratings" (
	"review_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	CONSTRAINT "vendor_review_ratings_review_id_criterion_id_pk" PRIMARY KEY("review_id","criterion_id"),
	CONSTRAINT "vendor_review_ratings_chk" CHECK ("vendor_review_ratings"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "vendor_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"reviewer_id" text,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scorecard_criteria" ADD CONSTRAINT "scorecard_criteria_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_review_ratings" ADD CONSTRAINT "vendor_review_ratings_review_id_vendor_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."vendor_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_review_ratings" ADD CONSTRAINT "vendor_review_ratings_criterion_id_scorecard_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."scorecard_criteria"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_reviews" ADD CONSTRAINT "vendor_reviews_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_reviews" ADD CONSTRAINT "vendor_reviews_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scorecard_criteria_code_uidx" ON "scorecard_criteria" USING btree ("company_id",lower("code"));--> statement-breakpoint
CREATE INDEX "vendor_review_ratings_criterion_idx" ON "vendor_review_ratings" USING btree ("criterion_id");--> statement-breakpoint
CREATE INDEX "vendor_reviews_vendor_idx" ON "vendor_reviews" USING btree ("vendor_id","created_at");--> statement-breakpoint
-- A review is a record of what someone thought on the day: it is added, never changed or deleted.
CREATE TRIGGER vendor_reviews_append_only BEFORE UPDATE OR DELETE ON "vendor_reviews" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER vendor_review_ratings_append_only BEFORE UPDATE OR DELETE ON "vendor_review_ratings" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();
