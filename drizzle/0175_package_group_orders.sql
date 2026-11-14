CREATE TABLE "package_group_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"person_name" text NOT NULL,
	"picks" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"selection_key" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_group_entries_name_chk" CHECK (length(btrim("package_group_entries"."person_name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "package_group_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"package_product_id" text NOT NULL,
	"package_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"organiser_customer_id" text NOT NULL,
	"organiser_name" text NOT NULL,
	"for_date" text,
	"closes_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_group_orders_status_chk" CHECK ("package_group_orders"."status" IN ('open', 'closed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "package_group_entries" ADD CONSTRAINT "package_group_entries_group_id_package_group_orders_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."package_group_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_group_orders" ADD CONSTRAINT "package_group_orders_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "package_group_entries_group_idx" ON "package_group_entries" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "package_group_orders_token_uidx" ON "package_group_orders" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "package_group_orders_organiser_idx" ON "package_group_orders" USING btree ("company_id","organiser_customer_id","created_at");