CREATE TABLE "route_par_levels" (
	"route_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"quantity" numeric(16, 3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_par_levels_route_id_product_id_pk" PRIMARY KEY("route_id","product_id"),
	CONSTRAINT "route_par_quantity_chk" CHECK ("route_par_levels"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "route_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"visit_days" smallint NOT NULL,
	"every_weeks" smallint NOT NULL,
	"anchor_date" date NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "route_stops_days_chk" CHECK ("route_stops"."visit_days" BETWEEN 1 AND 127),
	CONSTRAINT "route_stops_every_chk" CHECK ("route_stops"."every_weeks" IN (1,2,4)),
	CONSTRAINT "route_stops_sequence_chk" CHECK ("route_stops"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "sales_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"default_van_id" uuid,
	"default_rep_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_routes_mode_chk" CHECK ("sales_routes"."mode" IN ('van_sell','pre_sell','both')),
	CONSTRAINT "sales_routes_status_chk" CHECK ("sales_routes"."status" IN ('active','stopped')),
	CONSTRAINT "sales_routes_stopped_reason_chk" CHECK ("sales_routes"."status" = 'active' OR ("sales_routes"."status_reason" IS NOT NULL AND length(btrim("sales_routes"."status_reason")) > 0)),
	CONSTRAINT "sales_routes_pre_sell_van_chk" CHECK ("sales_routes"."mode" <> 'pre_sell' OR "sales_routes"."default_van_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "route_par_levels" ADD CONSTRAINT "route_par_levels_route_id_sales_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."sales_routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_par_levels" ADD CONSTRAINT "route_par_levels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_par_levels" ADD CONSTRAINT "route_par_levels_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_route_id_sales_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."sales_routes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stops_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_routes" ADD CONSTRAINT "sales_routes_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_routes" ADD CONSTRAINT "sales_routes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_routes" ADD CONSTRAINT "sales_routes_default_van_id_vans_id_fk" FOREIGN KEY ("default_van_id") REFERENCES "public"."vans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_routes" ADD CONSTRAINT "sales_routes_default_rep_id_sales_reps_id_fk" FOREIGN KEY ("default_rep_id") REFERENCES "public"."sales_reps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "route_par_product_idx" ON "route_par_levels" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "route_stops_route_customer_uidx" ON "route_stops" USING btree ("route_id","customer_id") WHERE "route_stops"."active";--> statement-breakpoint
CREATE INDEX "route_stops_route_idx" ON "route_stops" USING btree ("route_id","active","sequence","id");--> statement-breakpoint
CREATE INDEX "route_stops_customer_idx" ON "route_stops" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_routes_company_code_uidx" ON "sales_routes" USING btree ("company_id",lower("code"));--> statement-breakpoint
CREATE UNIQUE INDEX "sales_routes_company_name_uidx" ON "sales_routes" USING btree ("company_id",lower("name"));--> statement-breakpoint
CREATE INDEX "sales_routes_company_status_idx" ON "sales_routes" USING btree ("company_id","status","name");--> statement-breakpoint
CREATE INDEX "sales_routes_van_idx" ON "sales_routes" USING btree ("default_van_id");--> statement-breakpoint
CREATE INDEX "sales_routes_rep_idx" ON "sales_routes" USING btree ("default_rep_id");