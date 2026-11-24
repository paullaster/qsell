CREATE TABLE "van_sales_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"van_sell" boolean DEFAULT false NOT NULL,
	"pre_sell" boolean DEFAULT false NOT NULL,
	"off_route" text DEFAULT 'allow' NOT NULL,
	"overnight_stock" boolean DEFAULT false NOT NULL,
	"shortage" text DEFAULT 'charge_rep' NOT NULL,
	"shortage_approval_above" numeric(14, 2) DEFAULT '1000' NOT NULL,
	"position" text DEFAULT 'record' NOT NULL,
	"near_metres" integer DEFAULT 200 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "van_sales_settings_off_route_chk" CHECK ("van_sales_settings"."off_route" IN ('allow','refuse')),
	CONSTRAINT "van_sales_settings_shortage_chk" CHECK ("van_sales_settings"."shortage" IN ('charge_rep','write_off')),
	CONSTRAINT "van_sales_settings_position_chk" CHECK ("van_sales_settings"."position" IN ('record','require')),
	CONSTRAINT "van_sales_settings_limit_chk" CHECK ("van_sales_settings"."shortage_approval_above" >= 0),
	CONSTRAINT "van_sales_settings_near_chk" CHECK ("van_sales_settings"."near_metres" BETWEEN 20 AND 5000)
);
--> statement-breakpoint
ALTER TABLE "van_sales_settings" ADD CONSTRAINT "van_sales_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;