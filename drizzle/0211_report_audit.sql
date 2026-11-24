CREATE TABLE "report_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "report_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"report_code" text NOT NULL,
	"action" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"format" text,
	"row_count" integer,
	"truncated" boolean DEFAULT false NOT NULL,
	"content_hash" text,
	"definitions_version" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_audit_action_chk" CHECK ("report_audit"."action" in ('run', 'export')),
	CONSTRAINT "report_audit_format_chk" CHECK ("report_audit"."format" is null or "report_audit"."format" in ('csv', 'xlsx', 'pdf')),
	CONSTRAINT "report_audit_export_chk" CHECK ("report_audit"."action" <> 'export' or ("report_audit"."format" is not null and "report_audit"."content_hash" is not null))
);
--> statement-breakpoint
ALTER TABLE "report_audit" ADD CONSTRAINT "report_audit_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_audit_company_time_idx" ON "report_audit" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "report_audit_report_time_idx" ON "report_audit" USING btree ("company_id","report_code","occurred_at");--> statement-breakpoint
CREATE INDEX "report_audit_user_time_idx" ON "report_audit" USING btree ("company_id","user_id","occurred_at");--> statement-breakpoint
-- The audit is kept: who ran or downloaded a report is never changed or removed. (A correction would be a new row.)
CREATE FUNCTION report_audit_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'report audit rows are kept; they cannot be changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER report_audit_no_change BEFORE UPDATE OR DELETE ON "report_audit" FOR EACH ROW EXECUTE FUNCTION report_audit_guard();
