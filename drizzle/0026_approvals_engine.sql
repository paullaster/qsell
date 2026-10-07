CREATE TABLE "approval_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"step_sequence" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"on_behalf_of_user_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"comment" text,
	"reason_code" text,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"document_kind" text NOT NULL,
	"document_id" text NOT NULL,
	"branch_id" uuid,
	"requested_by" uuid NOT NULL,
	"amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"document_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_step" integer NOT NULL,
	"previous_request_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approval_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"module" text NOT NULL,
	"trigger" text,
	"branch_id" uuid,
	"enabled" boolean NOT NULL,
	"changed_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "approval_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"module" text NOT NULL,
	"trigger" text NOT NULL,
	"branch_id" uuid,
	"priority" integer DEFAULT 100 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approver_group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	CONSTRAINT "approver_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "approver_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approver_limits" (
	"profile_id" uuid NOT NULL,
	"document_kind" text NOT NULL,
	"max_amount" numeric(18, 2),
	"unlimited" boolean DEFAULT false NOT NULL,
	CONSTRAINT "approver_limits_profile_id_document_kind_pk" PRIMARY KEY("profile_id","document_kind")
);
--> statement-breakpoint
CREATE TABLE "approver_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"approver_user_id" uuid,
	"substitute_user_id" uuid,
	"substitute_from" text,
	"substitute_to" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_entries" ADD CONSTRAINT "approval_entries_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_entries" ADD CONSTRAINT "approval_entries_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_entries" ADD CONSTRAINT "approval_entries_on_behalf_of_user_id_users_id_fk" FOREIGN KEY ("on_behalf_of_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workflow_id_approval_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."approval_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workflow_version_id_approval_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."approval_workflow_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_switches" ADD CONSTRAINT "approval_switches_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_switches" ADD CONSTRAINT "approval_switches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_workflow_versions" ADD CONSTRAINT "approval_workflow_versions_workflow_id_approval_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."approval_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_workflows" ADD CONSTRAINT "approval_workflows_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_workflows" ADD CONSTRAINT "approval_workflows_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_group_members" ADD CONSTRAINT "approver_group_members_group_id_approver_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."approver_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_group_members" ADD CONSTRAINT "approver_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_groups" ADD CONSTRAINT "approver_groups_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_limits" ADD CONSTRAINT "approver_limits_profile_id_approver_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."approver_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_profiles" ADD CONSTRAINT "approver_profiles_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_profiles" ADD CONSTRAINT "approver_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_profiles" ADD CONSTRAINT "approver_profiles_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approver_profiles" ADD CONSTRAINT "approver_profiles_substitute_user_id_users_id_fk" FOREIGN KEY ("substitute_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_entries_inbox_idx" ON "approval_entries" USING btree ("approver_user_id","created_at") WHERE "approval_entries"."status" = 'open';--> statement-breakpoint
CREATE INDEX "approval_entries_request_idx" ON "approval_entries" USING btree ("request_id","step_sequence","position");--> statement-breakpoint
CREATE INDEX "approval_entries_overdue_idx" ON "approval_entries" USING btree ("due_at") WHERE "approval_entries"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending_uidx" ON "approval_requests" USING btree ("company_id","document_kind","document_id","workflow_id") WHERE "approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_requests_document_idx" ON "approval_requests" USING btree ("document_kind","document_id","created_at");--> statement-breakpoint
CREATE INDEX "approval_requests_submission_idx" ON "approval_requests" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_switches_scope_uidx" ON "approval_switches" USING btree ("company_id","module",coalesce("trigger", ''),coalesce("branch_id"::text, ''));--> statement-breakpoint
CREATE UNIQUE INDEX "approval_workflow_versions_uidx" ON "approval_workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_workflows_company_code_uidx" ON "approval_workflows" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "approval_workflows_trigger_idx" ON "approval_workflows" USING btree ("company_id","trigger","status");--> statement-breakpoint
CREATE INDEX "approver_group_members_seq_idx" ON "approver_group_members" USING btree ("group_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "approver_groups_company_code_uidx" ON "approver_groups" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "approver_profiles_user_uidx" ON "approver_profiles" USING btree ("company_id","user_id");