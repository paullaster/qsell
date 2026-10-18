CREATE TABLE "project_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "project_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"budget_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"sort_order" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_tasks_code_chk" CHECK ("project_tasks"."code" ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
	CONSTRAINT "project_tasks_name_chk" CHECK (char_length(btrim("project_tasks"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "project_tasks_description_chk" CHECK ("project_tasks"."description" IS NULL OR char_length("project_tasks"."description") <= 2000),
	CONSTRAINT "project_tasks_budget_chk" CHECK ("project_tasks"."budget_amount" >= 0),
	CONSTRAINT "project_tasks_version_chk" CHECK ("project_tasks"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"customer_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"billable" boolean DEFAULT false NOT NULL,
	"currency" text NOT NULL,
	"budget_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"start_on" date,
	"end_on" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"opened_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_name_chk" CHECK (char_length(btrim("projects"."name")) BETWEEN 1 AND 120),
	CONSTRAINT "projects_description_chk" CHECK ("projects"."description" IS NULL OR char_length("projects"."description") <= 2000),
	CONSTRAINT "projects_currency_chk" CHECK (char_length("projects"."currency") = 3),
	CONSTRAINT "projects_budget_chk" CHECK ("projects"."budget_amount" >= 0),
	CONSTRAINT "projects_dates_chk" CHECK ("projects"."end_on" IS NULL OR "projects"."start_on" IS NULL OR "projects"."end_on" >= "projects"."start_on"),
	CONSTRAINT "projects_version_chk" CHECK ("projects"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_events_project_idx" ON "project_events" USING btree ("project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_tasks_project_code_uidx" ON "project_tasks" USING btree ("project_id","code");--> statement-breakpoint
CREATE INDEX "project_tasks_order_idx" ON "project_tasks" USING btree ("project_id","sort_order","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_company_number_uidx" ON "projects" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_idem_uidx" ON "projects" USING btree ("company_id","idempotency_key") WHERE "projects"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "projects_list_idx" ON "projects" USING btree ("company_id","created_at","id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "projects_customer_idx" ON "projects" USING btree ("company_id","customer_id","created_at");--> statement-breakpoint
-- A project's history is kept: a later step is a new row, never a rewrite of an old one.
CREATE TRIGGER project_events_append_only BEFORE UPDATE OR DELETE ON "project_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();