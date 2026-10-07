CREATE TABLE "decision_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company_id" uuid NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"reason_code" text,
	"reason_text" text,
	"policy_id" text,
	"policy_version" text,
	"from_state" text,
	"to_state" text,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"mode" text DEFAULT 'gap_free' NOT NULL,
	"manual_allowed" boolean DEFAULT false NOT NULL,
	"default_numbers" boolean DEFAULT true NOT NULL,
	"date_order" boolean DEFAULT false NOT NULL,
	"block_size" integer DEFAULT 50 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"line_id" uuid,
	"number" text NOT NULL,
	"sequence" bigint,
	"period_key" text DEFAULT '' NOT NULL,
	"branch_id" uuid,
	"document_kind" text,
	"document_id" text,
	"source" text DEFAULT 'auto' NOT NULL,
	"document_date" text NOT NULL,
	"allocated_by" text,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_kind" text NOT NULL,
	"branch_id" uuid,
	"series_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid NOT NULL,
	"period_key" text DEFAULT '' NOT NULL,
	"last_no" bigint,
	"last_date" text,
	"warned" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"branch_id" uuid,
	"starts_on" text NOT NULL,
	"ends_on" text,
	"prefix" text DEFAULT '' NOT NULL,
	"suffix" text DEFAULT '' NOT NULL,
	"digits" integer DEFAULT 6 NOT NULL,
	"start_no" bigint DEFAULT 1 NOT NULL,
	"end_no" bigint,
	"increment" integer DEFAULT 1 NOT NULL,
	"warn_at" bigint,
	"reset" text DEFAULT 'never' NOT NULL,
	"is_open" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series_relationships" (
	"series_id" uuid NOT NULL,
	"related_series_id" uuid NOT NULL,
	CONSTRAINT "number_series_relationships_series_id_related_series_id_pk" PRIMARY KEY("series_id","related_series_id")
);
--> statement-breakpoint
CREATE TABLE "reason_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"applies_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_comment" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decision_log" ADD CONSTRAINT "decision_log_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_allocations" ADD CONSTRAINT "number_series_allocations_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_allocations" ADD CONSTRAINT "number_series_allocations_series_id_number_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."number_series"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_allocations" ADD CONSTRAINT "number_series_allocations_line_id_number_series_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."number_series_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_allocations" ADD CONSTRAINT "number_series_allocations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_bindings" ADD CONSTRAINT "number_series_bindings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_bindings" ADD CONSTRAINT "number_series_bindings_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_bindings" ADD CONSTRAINT "number_series_bindings_series_id_number_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."number_series"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_counters" ADD CONSTRAINT "number_series_counters_line_id_number_series_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."number_series_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_lines" ADD CONSTRAINT "number_series_lines_series_id_number_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."number_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_lines" ADD CONSTRAINT "number_series_lines_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_relationships" ADD CONSTRAINT "number_series_relationships_series_id_number_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."number_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series_relationships" ADD CONSTRAINT "number_series_relationships_related_series_id_number_series_id_fk" FOREIGN KEY ("related_series_id") REFERENCES "public"."number_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reason_codes" ADD CONSTRAINT "reason_codes_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_log_subject_idx" ON "decision_log" USING btree ("subject_type","subject_id","occurred_at");--> statement-breakpoint
CREATE INDEX "decision_log_correlation_idx" ON "decision_log" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "decision_log_company_time_idx" ON "decision_log" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_company_code_uidx" ON "number_series" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_alloc_number_uidx" ON "number_series_allocations" USING btree ("series_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_alloc_document_uidx" ON "number_series_allocations" USING btree ("company_id","document_kind","document_id") WHERE "number_series_allocations"."document_kind" is not null and "number_series_allocations"."document_id" is not null;--> statement-breakpoint
CREATE INDEX "number_series_alloc_time_idx" ON "number_series_allocations" USING btree ("series_id","allocated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_bind_default_uidx" ON "number_series_bindings" USING btree ("company_id","document_kind") WHERE "number_series_bindings"."branch_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_bind_branch_uidx" ON "number_series_bindings" USING btree ("company_id","document_kind","branch_id") WHERE "number_series_bindings"."branch_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_counters_line_period_uidx" ON "number_series_counters" USING btree ("line_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_lines_series_no_uidx" ON "number_series_lines" USING btree ("series_id","line_no");--> statement-breakpoint
CREATE INDEX "number_series_lines_series_idx" ON "number_series_lines" USING btree ("series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reason_codes_company_code_uidx" ON "reason_codes" USING btree ("company_id","code");
--> statement-breakpoint
-- Append-only facts: the database itself refuses to change or delete them.
CREATE FUNCTION kernel_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER decision_log_append_only BEFORE UPDATE OR DELETE ON "decision_log" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER number_series_alloc_append_only BEFORE UPDATE OR DELETE ON "number_series_allocations" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();
