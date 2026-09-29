CREATE TABLE "product_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"total_rows" integer NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_by_email" text DEFAULT '' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"data" jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"product_id" text,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "product_import_jobs" ADD CONSTRAINT "product_import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_job_id_product_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."product_import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_rows" ADD CONSTRAINT "product_import_rows_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_import_jobs_created_idx" ON "product_import_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_import_jobs_active_file_uidx" ON "product_import_jobs" USING btree ("file_sha256") WHERE "product_import_jobs"."status" in ('queued', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "product_import_rows_job_row_uidx" ON "product_import_rows" USING btree ("job_id","row_number");--> statement-breakpoint
CREATE INDEX "product_import_rows_job_status_idx" ON "product_import_rows" USING btree ("job_id","status","row_number");