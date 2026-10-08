CREATE TABLE "discount_counters" (
	"rule_id" uuid NOT NULL,
	"shard" integer NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"amount" numeric(16, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "discount_counters_rule_id_shard_pk" PRIMARY KEY("rule_id","shard")
);
--> statement-breakpoint
CREATE TABLE "discount_coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"code" text NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"max_uses" integer,
	"max_uses_per_customer" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_status" text DEFAULT 'none' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"stacking" text DEFAULT 'exclusive' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"schedule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reward" jsonb NOT NULL,
	"requires_coupon" boolean DEFAULT false NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"strict_limits" boolean DEFAULT false NOT NULL,
	"applies_to_contract" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_version" integer NOT NULL,
	"coupon_id" uuid,
	"coupon_code" text,
	"customer_id" uuid,
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"kind" text DEFAULT 'use' NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discounts" jsonb;--> statement-breakpoint
ALTER TABLE "sales_quote_lines" ADD COLUMN "rule_discount_percent" numeric(9, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD COLUMN "coupon_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_quotes" ADD COLUMN "discounts" jsonb;--> statement-breakpoint
ALTER TABLE "discount_counters" ADD CONSTRAINT "discount_counters_rule_id_discount_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."discount_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_coupons" ADD CONSTRAINT "discount_coupons_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_coupons" ADD CONSTRAINT "discount_coupons_rule_id_discount_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."discount_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_rules" ADD CONSTRAINT "discount_rules_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usage" ADD CONSTRAINT "discount_usage_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usage" ADD CONSTRAINT "discount_usage_rule_id_discount_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."discount_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usage" ADD CONSTRAINT "discount_usage_coupon_id_discount_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."discount_coupons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discount_coupons_company_code_uidx" ON "discount_coupons" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "discount_coupons_rule_idx" ON "discount_coupons" USING btree ("rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_rules_company_code_uidx" ON "discount_rules" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "discount_rules_company_status_idx" ON "discount_rules" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_usage_document_uidx" ON "discount_usage" USING btree ("rule_id","document_type","document_id","kind");--> statement-breakpoint
CREATE INDEX "discount_usage_customer_idx" ON "discount_usage" USING btree ("rule_id","customer_id");--> statement-breakpoint
CREATE INDEX "discount_usage_coupon_idx" ON "discount_usage" USING btree ("coupon_id","customer_id");--> statement-breakpoint
-- Every use of a discount is a fact: the database itself refuses to change or delete it.
CREATE TRIGGER discount_usage_append_only BEFORE UPDATE OR DELETE ON "discount_usage" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();
