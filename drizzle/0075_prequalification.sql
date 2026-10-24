CREATE TABLE "category_documents" (
	"category_id" uuid NOT NULL,
	"document_type_id" uuid NOT NULL,
	CONSTRAINT "category_documents_category_id_document_type_id_pk" PRIMARY KEY("category_id","document_type_id")
);
--> statement-breakpoint
CREATE TABLE "category_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"prompt" text NOT NULL,
	"kind" text NOT NULL,
	"choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weight" integer DEFAULT 0 NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "category_questions_kind_chk" CHECK ("category_questions"."kind" IN ('yes_no','number','text','choice')),
	CONSTRAINT "category_questions_weight_chk" CHECK ("category_questions"."weight" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "prequal_answers" (
	"entry_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "prequal_answers_entry_id_question_id_pk" PRIMARY KEY("entry_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "prequal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"previous_entry_id" uuid,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"reason_code" text,
	"decision_comment" text,
	"revision_due" date,
	"valid_from" date,
	"valid_until" date,
	"max_order_value" numeric(14, 2),
	"conditions_note" text,
	"total_score" numeric(7, 2),
	"max_score" numeric(7, 2),
	"suspended_because" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prequal_entries_status_chk" CHECK ("prequal_entries"."status" IN ('draft','submitted','in_review','revision_requested','approved','rejected','withdrawn','expired','suspended','revoked'))
);
--> statement-breakpoint
CREATE TABLE "prequal_evaluators" (
	"entry_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prequal_evaluators_entry_id_user_id_pk" PRIMARY KEY("entry_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "prequal_scores" (
	"entry_id" uuid NOT NULL,
	"evaluator_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"comment" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prequal_scores_entry_id_evaluator_id_question_id_pk" PRIMARY KEY("entry_id","evaluator_id","question_id"),
	CONSTRAINT "prequal_scores_score_chk" CHECK ("prequal_scores"."score" >= 0)
);
--> statement-breakpoint
CREATE TABLE "procurement_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"parent_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"validity_months" integer DEFAULT 24 NOT NULL,
	"window_from" date,
	"window_to" date,
	"pass_mark_percent" numeric(5, 2),
	"four_eyes" boolean DEFAULT true NOT NULL,
	"show_total_score" boolean DEFAULT false NOT NULL,
	"show_pass_mark" boolean DEFAULT false NOT NULL,
	"show_question_scores" boolean DEFAULT false NOT NULL,
	"show_evaluator_comments" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "procurement_categories_code_chk" CHECK ("procurement_categories"."code" ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$'),
	CONSTRAINT "procurement_categories_status_chk" CHECK ("procurement_categories"."status" IN ('draft','open','closed','archived')),
	CONSTRAINT "procurement_categories_validity_chk" CHECK ("procurement_categories"."validity_months" BETWEEN 1 AND 120),
	CONSTRAINT "procurement_categories_pass_chk" CHECK ("procurement_categories"."pass_mark_percent" IS NULL OR "procurement_categories"."pass_mark_percent" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "category_documents" ADD CONSTRAINT "category_documents_category_id_procurement_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."procurement_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_documents" ADD CONSTRAINT "category_documents_document_type_id_vendor_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."vendor_document_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_questions" ADD CONSTRAINT "category_questions_category_id_procurement_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."procurement_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prequal_answers" ADD CONSTRAINT "prequal_answers_entry_id_prequal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."prequal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prequal_answers" ADD CONSTRAINT "prequal_answers_question_id_category_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."category_questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prequal_entries" ADD CONSTRAINT "prequal_entries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prequal_entries" ADD CONSTRAINT "prequal_entries_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prequal_entries" ADD CONSTRAINT "prequal_entries_category_id_procurement_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."procurement_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prequal_entries" ADD CONSTRAINT "prequal_entries_previous_entry_id_prequal_entries_id_fk" FOREIGN KEY ("previous_entry_id") REFERENCES "public"."prequal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prequal_evaluators" ADD CONSTRAINT "prequal_evaluators_entry_id_prequal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."prequal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prequal_scores" ADD CONSTRAINT "prequal_scores_entry_id_prequal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."prequal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prequal_scores" ADD CONSTRAINT "prequal_scores_question_id_category_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."category_questions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_categories" ADD CONSTRAINT "procurement_categories_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_categories" ADD CONSTRAINT "procurement_categories_parent_id_procurement_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."procurement_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_questions_category_idx" ON "category_questions" USING btree ("category_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "prequal_entries_live_uidx" ON "prequal_entries" USING btree ("vendor_id","category_id") WHERE "prequal_entries"."status" IN ('draft','submitted','in_review','revision_requested','approved','suspended');--> statement-breakpoint
CREATE INDEX "prequal_entries_category_idx" ON "prequal_entries" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "prequal_entries_queue_idx" ON "prequal_entries" USING btree ("company_id","status","submitted_at");--> statement-breakpoint
CREATE INDEX "prequal_entries_valid_idx" ON "prequal_entries" USING btree ("valid_until") WHERE "prequal_entries"."status" IN ('approved','suspended');--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_categories_company_code_uidx" ON "procurement_categories" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "procurement_categories_parent_idx" ON "procurement_categories" USING btree ("parent_id");--> statement-breakpoint
-- A category's questions and required documents are the terms vendors applied under: they can be changed only while the
-- category is still a draft (to change them later, close the category and make a new one).
CREATE FUNCTION prequal_guard_category_terms() RETURNS trigger AS $$
DECLARE
  cat uuid;
  st text;
BEGIN
  cat := COALESCE(NEW.category_id, OLD.category_id);
  SELECT status INTO st FROM procurement_categories WHERE id = cat;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'the questions and documents of a category cannot change once it has been opened' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER category_questions_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON "category_questions" FOR EACH ROW EXECUTE FUNCTION prequal_guard_category_terms();--> statement-breakpoint
CREATE TRIGGER category_documents_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON "category_documents" FOR EACH ROW EXECUTE FUNCTION prequal_guard_category_terms();
