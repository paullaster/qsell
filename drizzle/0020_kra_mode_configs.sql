CREATE TABLE "branch_kra_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"api_base_url" text,
	"credentials_encrypted" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_kra_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"api_base_url" text,
	"credentials_encrypted" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kra_transmissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text,
	"branch_id" uuid,
	"config_source" text NOT NULL,
	"mode" text NOT NULL,
	"trader_invoice_no" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb,
	"error_code" text,
	"error_message" text,
	"scu_receipt_no" text,
	"verification_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branch_kra_configs" ADD CONSTRAINT "branch_kra_configs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_kra_configs" ADD CONSTRAINT "company_kra_configs_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kra_transmissions" ADD CONSTRAINT "kra_transmissions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_kra_configs_branch_uidx" ON "branch_kra_configs" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_kra_configs_company_uidx" ON "company_kra_configs" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kra_transmissions_trader_invoice_uidx" ON "kra_transmissions" USING btree ("trader_invoice_no");--> statement-breakpoint
CREATE INDEX "kra_transmissions_status_idx" ON "kra_transmissions" USING btree ("status");