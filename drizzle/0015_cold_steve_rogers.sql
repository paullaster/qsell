CREATE TABLE "application_error_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text DEFAULT 'server' NOT NULL,
	"error_name" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"digest" text,
	"path" text,
	"method" text,
	"route_path" text,
	"route_type" text,
	"runtime" text,
	"request_id" text,
	"user_agent" text,
	"actor_user_id" uuid,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_error_logs" ADD CONSTRAINT "application_error_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_error_logs_created_idx" ON "application_error_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "application_error_logs_digest_idx" ON "application_error_logs" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "application_error_logs_route_idx" ON "application_error_logs" USING btree ("route_path","created_at");