CREATE TABLE "payment_gateway_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"credentials_encrypted" jsonb,
	"supported_currencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"order_number" text DEFAULT '' NOT NULL,
	"gateway_provider" text NOT NULL,
	"transaction_reference" text NOT NULL,
	"external_reference" text,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"customer_phone" text,
	"customer_email" text,
	"request_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ipn_status" text DEFAULT 'pending' NOT NULL,
	"reconciliation_status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text DEFAULT '' NOT NULL,
	"order_id" text NOT NULL,
	"order_number" text DEFAULT '' NOT NULL,
	"provider" text NOT NULL,
	"reconciliation_type" text DEFAULT 'manual_override' NOT NULL,
	"order_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"received_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discrepancy_found" boolean DEFAULT false NOT NULL,
	"discrepancy_type" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'matched' NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"role" text DEFAULT 'customer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "payment_transactions_order_idx" ON "payment_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_transactions_ref_idx" ON "payment_transactions" USING btree ("transaction_reference");--> statement-breakpoint
CREATE INDEX "payment_transactions_status_idx" ON "payment_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reconciliation_logs_order_idx" ON "reconciliation_logs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "reconciliation_logs_transaction_idx" ON "reconciliation_logs" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "reconciliation_logs_created_idx" ON "reconciliation_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");