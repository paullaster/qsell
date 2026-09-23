CREATE TABLE "access_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"permission_key" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"resource" text,
	"condition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effect" text DEFAULT 'allow' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_policies_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"resource_id" text,
	"detail" jsonb,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"street_address" text,
	"city" text,
	"county_or_state" text,
	"postal_code" text,
	"country" text DEFAULT 'Kenya',
	"kra_pin" text,
	"vat_number" text,
	"registration_number" text,
	"bank_name" text,
	"bank_account_name" text,
	"bank_account_number" text,
	"bank_branch" text,
	"acts_independently" boolean DEFAULT false NOT NULL,
	"public_base_url" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"template_key" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"legal_name" text NOT NULL,
	"trading_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"tel" text,
	"website" text,
	"street_address" text NOT NULL,
	"city" text NOT NULL,
	"county_or_state" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text DEFAULT 'Kenya' NOT NULL,
	"location_label" text,
	"tagline" text,
	"kra_pin" text NOT NULL,
	"vat_number" text,
	"registration_number" text,
	"bank_name" text,
	"bank_account_name" text,
	"bank_account_number" text,
	"bank_branch" text,
	"invoice_footer_note" text,
	"invoice_prefix" text DEFAULT 'INV' NOT NULL,
	"logo_url" text,
	"primary_color" text DEFAULT '#111827' NOT NULL,
	"accent_color" text DEFAULT '#4F46E5' NOT NULL,
	"public_base_url" text,
	"ui_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"street" text NOT NULL,
	"city" text NOT NULL,
	"county_or_state" text NOT NULL,
	"postal_code" text,
	"country" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" text,
	"document_type" text NOT NULL,
	"document_no" text NOT NULL,
	"description" text,
	"amount" numeric(14, 2) NOT NULL,
	"remaining_amount" numeric(14, 2) NOT NULL,
	"due_date" timestamp with time zone,
	"kra_transmission_status" text DEFAULT 'not_applicable' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"account_type" text NOT NULL,
	"credit_limit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"payment_term_days" integer DEFAULT 0 NOT NULL,
	"transmit_invoices_to_kra" boolean DEFAULT false NOT NULL,
	"dimension_codes" jsonb DEFAULT '{"global":{},"shortcut":{}}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_id" uuid,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"street" text,
	"city" text,
	"county_or_state" text,
	"postal_code" text,
	"country" text,
	"account_type" text NOT NULL,
	"credit_limit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"payment_term_days" integer DEFAULT 0 NOT NULL,
	"blocked" text DEFAULT 'none' NOT NULL,
	"transmit_invoices_to_kra" boolean DEFAULT false NOT NULL,
	"buyer_kra_pin" text,
	"dimension_set_id" uuid,
	"dimension_codes" jsonb DEFAULT '{"global":{},"shortcut":{}}'::jsonb NOT NULL,
	"balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dimension_set_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dimension_set_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"dimension_value_id" uuid NOT NULL,
	"dimension_code" text NOT NULL,
	"dimension_value_code" text NOT NULL,
	"dimension_no" integer,
	"is_global" boolean DEFAULT false NOT NULL,
	"is_shortcut" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dimension_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dimension_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dimension_id" uuid NOT NULL,
	"dimension_code" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"linked_branch_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"dimension_no" integer,
	"is_global" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_shortcut" boolean DEFAULT false NOT NULL,
	"option_string" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"order_number" text NOT NULL,
	"invoice_number" text NOT NULL,
	"document_type" text DEFAULT 'tax_invoice' NOT NULL,
	"customer_email" text NOT NULL,
	"customer_name" text NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"tax" numeric(14, 2) NOT NULL,
	"shipping_fee" numeric(14, 2) NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"pdf_storage_key" text,
	"email_status" text DEFAULT 'pending' NOT NULL,
	"email_error" text,
	"emailed_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_documents_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"sku" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"total_price" numeric(14, 2) NOT NULL,
	"image_url" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"user_id" text,
	"branch_id" uuid,
	"customer_name" text NOT NULL,
	"customer_email" text NOT NULL,
	"customer_phone" text NOT NULL,
	"shipping_address" jsonb NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"tax" numeric(14, 2) NOT NULL,
	"shipping_fee" numeric(14, 2) NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"payment_method" text NOT NULL,
	"shipping_courier" text,
	"tracking_number" text,
	"internal_notes" text,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"transaction_reference" text,
	"mpesa_receipt_number" text,
	"pesapal_tracking_id" text,
	"dimension_set_id" uuid,
	"dimension_codes" jsonb DEFAULT '{"global":{},"shortcut":{}}'::jsonb NOT NULL,
	"trade_customer_id" uuid,
	"customer_account_type" text,
	"transmit_invoices_to_kra" boolean DEFAULT false NOT NULL,
	"kra_transmission_status" text DEFAULT 'not_applicable' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"provider_config_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"order_id" text NOT NULL,
	"order_number" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"callback_token" text NOT NULL,
	"callback_url" text NOT NULL,
	"customer_phone" text,
	"customer_email" text,
	"provider_reference" text,
	"external_reference" text,
	"redirect_url" text,
	"request_payload" jsonb DEFAULT '{}'::jsonb,
	"response_payload" jsonb DEFAULT '{}'::jsonb,
	"error_message" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_callback_token_unique" UNIQUE("callback_token")
);
--> statement-breakpoint
CREATE TABLE "payment_callback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_attempt_id" uuid,
	"callback_token" text NOT NULL,
	"provider_code" text NOT NULL,
	"http_method" text DEFAULT 'POST' NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb,
	"raw_body" jsonb,
	"processing_status" text DEFAULT 'received' NOT NULL,
	"outcome" text DEFAULT 'unclassified' NOT NULL,
	"processing_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"provider_code" text NOT NULL,
	"display_name" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"environment" text DEFAULT 'staging' NOT NULL,
	"api_base_url" text NOT NULL,
	"credentials_encrypted" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"category" text DEFAULT 'General' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"effect" text DEFAULT 'allow' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "transaction_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"order_id" text,
	"document_type" text NOT NULL,
	"document_no" text NOT NULL,
	"description" text,
	"direction" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"transaction_reference" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"effect" text NOT NULL,
	"branch_id" uuid,
	"assigned_by" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"branch_id" uuid,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"phone" text,
	"avatar_url" text,
	"role" text DEFAULT 'customer' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"customer_store_id" text,
	"branch_id" uuid,
	"permissions_version" integer DEFAULT 0 NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_profile_id_customer_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."customer_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_dimension_set_id_dimension_sets_id_fk" FOREIGN KEY ("dimension_set_id") REFERENCES "public"."dimension_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_set_entries" ADD CONSTRAINT "dimension_set_entries_dimension_set_id_dimension_sets_id_fk" FOREIGN KEY ("dimension_set_id") REFERENCES "public"."dimension_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_set_entries" ADD CONSTRAINT "dimension_set_entries_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_set_entries" ADD CONSTRAINT "dimension_set_entries_dimension_value_id_dimension_values_id_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_sets" ADD CONSTRAINT "dimension_sets_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_parent_id_dimension_values_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."dimension_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_linked_branch_id_branches_id_fk" FOREIGN KEY ("linked_branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_parent_id_dimensions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."dimensions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_dimension_set_id_dimension_sets_id_fk" FOREIGN KEY ("dimension_set_id") REFERENCES "public"."dimension_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_trade_customer_id_customers_id_fk" FOREIGN KEY ("trade_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_provider_config_id_payment_provider_configs_id_fk" FOREIGN KEY ("provider_config_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_callback_events" ADD CONSTRAINT "payment_callback_events_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_configs" ADD CONSTRAINT "payment_provider_configs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_ledger_entries" ADD CONSTRAINT "transaction_ledger_entries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_ledger_entries" ADD CONSTRAINT "transaction_ledger_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_policies_perm_idx" ON "access_policies" USING btree ("permission_key");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_resource_idx" ON "audit_logs" USING btree ("resource","resource_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "branches_company_code_uidx" ON "branches" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "branches_company_idx" ON "branches" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "customer_addresses_customer_idx" ON "customer_addresses" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_addresses_one_default_uidx" ON "customer_addresses" USING btree ("customer_id") WHERE "customer_addresses"."is_default" = true;--> statement-breakpoint
CREATE INDEX "customer_ledger_customer_idx" ON "customer_ledger_entries" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_ledger_order_idx" ON "customer_ledger_entries" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profiles_company_code_uidx" ON "customer_profiles" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "customer_profiles_company_idx" ON "customer_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_company_number_uidx" ON "customers" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "customers_company_idx" ON "customers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "customers_company_email_idx" ON "customers" USING btree ("company_id","email");--> statement-breakpoint
CREATE INDEX "customers_profile_idx" ON "customers" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dimension_set_entries_set_dim_uidx" ON "dimension_set_entries" USING btree ("dimension_set_id","dimension_id");--> statement-breakpoint
CREATE INDEX "dimension_set_entries_set_idx" ON "dimension_set_entries" USING btree ("dimension_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dimension_sets_company_hash_uidx" ON "dimension_sets" USING btree ("company_id","content_hash");--> statement-breakpoint
CREATE INDEX "dimension_sets_company_idx" ON "dimension_sets" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dimension_values_dim_code_uidx" ON "dimension_values" USING btree ("dimension_id","code");--> statement-breakpoint
CREATE INDEX "dimension_values_dimension_idx" ON "dimension_values" USING btree ("dimension_id");--> statement-breakpoint
CREATE INDEX "dimension_values_parent_idx" ON "dimension_values" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "dimension_values_dimension_code_idx" ON "dimension_values" USING btree ("dimension_code");--> statement-breakpoint
CREATE INDEX "dimension_values_linked_branch_idx" ON "dimension_values" USING btree ("linked_branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dimensions_company_code_uidx" ON "dimensions" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "dimensions_company_option_uidx" ON "dimensions" USING btree ("company_id","option_string");--> statement-breakpoint
CREATE UNIQUE INDEX "dimensions_company_no_uidx" ON "dimensions" USING btree ("company_id","dimension_no");--> statement-breakpoint
CREATE INDEX "dimensions_company_idx" ON "dimensions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "dimensions_parent_idx" ON "dimensions" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_uidx" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_customer_email_idx" ON "orders" USING btree ("customer_email");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_dimension_set_idx" ON "orders" USING btree ("dimension_set_id");--> statement-breakpoint
CREATE INDEX "orders_trade_customer_idx" ON "orders" USING btree ("trade_customer_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_order_idx" ON "payment_attempts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payment_attempts_callback_token_idx" ON "payment_attempts" USING btree ("callback_token");--> statement-breakpoint
CREATE INDEX "payment_attempts_branch_idx" ON "payment_attempts" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "payment_callback_events_token_idx" ON "payment_callback_events" USING btree ("callback_token");--> statement-breakpoint
CREATE INDEX "payment_callback_events_attempt_idx" ON "payment_callback_events" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "payment_callback_events_outcome_idx" ON "payment_callback_events" USING btree ("outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_configs_branch_provider_uidx" ON "payment_provider_configs" USING btree ("branch_id","provider_code");--> statement-breakpoint
CREATE INDEX "payment_provider_configs_branch_idx" ON "payment_provider_configs" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "permissions_resource_idx" ON "permissions" USING btree ("resource");--> statement-breakpoint
CREATE INDEX "permissions_category_idx" ON "permissions" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_role_perm_uidx" ON "role_permissions" USING btree ("role_id","permission_id");--> statement-breakpoint
CREATE INDEX "role_permissions_perm_idx" ON "role_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE INDEX "roles_key_idx" ON "roles" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_ledger_idempotency_uidx" ON "transaction_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "transaction_ledger_company_posted_idx" ON "transaction_ledger_entries" USING btree ("company_id","posted_at");--> statement-breakpoint
CREATE INDEX "transaction_ledger_order_idx" ON "transaction_ledger_entries" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_permissions_user_perm_eff_branch_uidx" ON "user_permissions" USING btree ("user_id","permission_id","effect","branch_id");--> statement-breakpoint
CREATE INDEX "user_permissions_user_idx" ON "user_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_permissions_perm_idx" ON "user_permissions" USING btree ("permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_user_role_branch_uidx" ON "user_roles" USING btree ("user_id","role_id","branch_id");--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uidx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_branch_idx" ON "users" USING btree ("branch_id");