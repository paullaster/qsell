CREATE TABLE "integration_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correlation_id" text NOT NULL,
	"direction" text NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"request_headers" jsonb,
	"response_headers" jsonb,
	"http_method" text,
	"url" text,
	"status_code" integer,
	"error_code" text,
	"error_message" text,
	"duration_ms" integer,
	"request_sent_at" timestamp with time zone,
	"response_received_at" timestamp with time zone,
	"callback_received_at" timestamp with time zone,
	"callback_payload" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"queue_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "callback_payload" jsonb;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "callback_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "callback_processed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "callback_audit_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "queue_job_id" text;--> statement-breakpoint
CREATE INDEX "integration_audit_correlation_idx" ON "integration_audit_log" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "integration_audit_provider_op_idx" ON "integration_audit_log" USING btree ("provider","operation");--> statement-breakpoint
CREATE INDEX "integration_audit_created_idx" ON "integration_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "integration_audit_queue_job_idx" ON "integration_audit_log" USING btree ("queue_job_id");--> statement-breakpoint
CREATE INDEX "integration_audit_retention_idx" ON "integration_audit_log" USING btree ("retention_until");--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_callback_audit_id_integration_audit_log_id_fk" FOREIGN KEY ("callback_audit_id") REFERENCES "public"."integration_audit_log"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_transactions_callback_audit_idx" ON "payment_transactions" USING btree ("callback_audit_id");