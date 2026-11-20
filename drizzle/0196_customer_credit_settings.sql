CREATE TABLE "customer_credit_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"credit_limit_display" text DEFAULT 'running' NOT NULL,
	"allow_over_credit_limit" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credit_settings_display_chk" CHECK ("customer_credit_settings"."credit_limit_display" IN ('running','static'))
);
--> statement-breakpoint
ALTER TABLE "customer_credit_settings" ADD CONSTRAINT "customer_credit_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;