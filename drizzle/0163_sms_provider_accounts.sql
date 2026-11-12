CREATE TABLE "sms_provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"adapter" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_sealed" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_provider_accounts_adapter_chk" CHECK ("sms_provider_accounts"."adapter" IN ('africastalking','twilio','log')),
	CONSTRAINT "sms_provider_accounts_default_chk" CHECK (NOT "sms_provider_accounts"."is_default" OR "sms_provider_accounts"."is_active"),
	CONSTRAINT "sms_provider_accounts_test_chk" CHECK (("sms_provider_accounts"."last_test_at" IS NULL) = ("sms_provider_accounts"."last_test_ok" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "sms_provider_accounts" ADD CONSTRAINT "sms_provider_accounts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_provider_accounts_name_uidx" ON "sms_provider_accounts" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "sms_provider_accounts_default_uidx" ON "sms_provider_accounts" USING btree ("company_id") WHERE "sms_provider_accounts"."is_default";