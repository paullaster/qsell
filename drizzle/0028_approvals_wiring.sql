CREATE TABLE "approval_parked_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_kind" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"summary" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'parked' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "approval_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_parked_actions" ADD CONSTRAINT "approval_parked_actions_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_parked_actions" ADD CONSTRAINT "approval_parked_actions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_parked_actions_kind_idx" ON "approval_parked_actions" USING btree ("document_kind","status","created_at");