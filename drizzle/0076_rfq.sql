CREATE TABLE "rfq_addenda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"body" text NOT NULL,
	"deadline_before" timestamp with time zone,
	"deadline_after" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfq_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"rfq_line_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"quote_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"justification" text,
	"awarded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfq_awards_qty_chk" CHECK ("rfq_awards"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "rfq_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rfq_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"rfq_id" uuid NOT NULL,
	"vendor_id" uuid,
	"event" text NOT NULL,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfq_invitations" (
	"rfq_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"decline_reason" text,
	"invited_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decision_reason" text,
	"decision_comment" text,
	"revision_due" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"result_seen_at" timestamp with time zone,
	CONSTRAINT "rfq_invitations_rfq_id_vendor_id_pk" PRIMARY KEY("rfq_id","vendor_id"),
	CONSTRAINT "rfq_invitations_status_chk" CHECK ("rfq_invitations"."status" IN ('invited','opened','declined')),
	CONSTRAINT "rfq_invitations_decision_chk" CHECK ("rfq_invitations"."decision" IN ('pending','accepted','rejected','revision_requested'))
);
--> statement-breakpoint
CREATE TABLE "rfq_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" text,
	"description" text NOT NULL,
	"specification" text,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"required_date" date,
	CONSTRAINT "rfq_lines_qty_chk" CHECK ("rfq_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "rfq_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"body" text NOT NULL,
	"answer" text,
	"published" boolean DEFAULT false NOT NULL,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfq_quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"rfq_line_id" uuid NOT NULL,
	"no_bid" boolean DEFAULT false NOT NULL,
	"is_alternative" boolean DEFAULT false NOT NULL,
	"unit_price" numeric(14, 2),
	"quantity" numeric(14, 3),
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"lead_time_days" integer,
	"brand" text,
	"warranty" text,
	"note" text,
	CONSTRAINT "rfq_quote_lines_price_chk" CHECK ("rfq_quote_lines"."unit_price" IS NULL OR "rfq_quote_lines"."unit_price" >= 0),
	CONSTRAINT "rfq_quote_lines_bid_chk" CHECK ("rfq_quote_lines"."no_bid" OR ("rfq_quote_lines"."unit_price" IS NOT NULL AND "rfq_quote_lines"."quantity" IS NOT NULL AND "rfq_quote_lines"."quantity" > 0))
);
--> statement-breakpoint
CREATE TABLE "rfq_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"payment_terms" text,
	"delivery_terms" text,
	"valid_until" date,
	"notes" text,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfq_quotes_status_chk" CHECK ("rfq_quotes"."status" IN ('draft','submitted','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"category_id" uuid NOT NULL,
	"description" text,
	"terms" text,
	"branch_id" uuid,
	"required_by" date,
	"deadline" timestamp with time zone NOT NULL,
	"validity_days" integer DEFAULT 30 NOT NULL,
	"currency" text NOT NULL,
	"sealed" boolean DEFAULT true NOT NULL,
	"opens_at" timestamp with time zone,
	"allow_partial" boolean DEFAULT false NOT NULL,
	"allow_alternatives" boolean DEFAULT false NOT NULL,
	"estimated_value" numeric(14, 2),
	"buyer_id" text,
	"created_by" text,
	"issued_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"awarded_at" timestamp with time zone,
	"award_note" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"reminded_48" boolean DEFAULT false NOT NULL,
	"reminded_4" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfqs_status_chk" CHECK ("rfqs"."status" IN ('draft','issued','closed','awarded','cancelled')),
	CONSTRAINT "rfqs_validity_chk" CHECK ("rfqs"."validity_days" BETWEEN 1 AND 365)
);
--> statement-breakpoint
ALTER TABLE "rfq_addenda" ADD CONSTRAINT "rfq_addenda_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_awards" ADD CONSTRAINT "rfq_awards_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_awards" ADD CONSTRAINT "rfq_awards_rfq_line_id_rfq_lines_id_fk" FOREIGN KEY ("rfq_line_id") REFERENCES "public"."rfq_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_awards" ADD CONSTRAINT "rfq_awards_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_awards" ADD CONSTRAINT "rfq_awards_quote_line_id_rfq_quote_lines_id_fk" FOREIGN KEY ("quote_line_id") REFERENCES "public"."rfq_quote_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_events" ADD CONSTRAINT "rfq_events_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_invitations" ADD CONSTRAINT "rfq_invitations_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_invitations" ADD CONSTRAINT "rfq_invitations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_questions" ADD CONSTRAINT "rfq_questions_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_questions" ADD CONSTRAINT "rfq_questions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_quote_lines" ADD CONSTRAINT "rfq_quote_lines_quote_id_rfq_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."rfq_quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_quote_lines" ADD CONSTRAINT "rfq_quote_lines_rfq_line_id_rfq_lines_id_fk" FOREIGN KEY ("rfq_line_id") REFERENCES "public"."rfq_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_category_id_procurement_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."procurement_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rfq_addenda_uidx" ON "rfq_addenda" USING btree ("rfq_id","number");--> statement-breakpoint
CREATE INDEX "rfq_awards_rfq_idx" ON "rfq_awards" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX "rfq_events_rfq_idx" ON "rfq_events" USING btree ("rfq_id","id");--> statement-breakpoint
CREATE INDEX "rfq_invitations_vendor_idx" ON "rfq_invitations" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "rfq_lines_rfq_idx" ON "rfq_lines" USING btree ("rfq_id","position");--> statement-breakpoint
CREATE INDEX "rfq_questions_rfq_idx" ON "rfq_questions" USING btree ("rfq_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rfq_quote_lines_uidx" ON "rfq_quote_lines" USING btree ("quote_id","rfq_line_id","is_alternative");--> statement-breakpoint
CREATE UNIQUE INDEX "rfq_quotes_version_uidx" ON "rfq_quotes" USING btree ("rfq_id","vendor_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "rfq_quotes_one_draft_uidx" ON "rfq_quotes" USING btree ("rfq_id","vendor_id") WHERE "rfq_quotes"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "rfq_quotes_rfq_idx" ON "rfq_quotes" USING btree ("rfq_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "rfqs_company_number_uidx" ON "rfqs" USING btree ("company_id","number") WHERE "rfqs"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "rfqs_company_status_idx" ON "rfqs" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "rfqs_deadline_idx" ON "rfqs" USING btree ("deadline") WHERE "rfqs"."status" = 'issued';--> statement-breakpoint
-- What was sent to vendors, asked, decided and awarded is a record: it can be added to, never changed or removed.
CREATE TRIGGER rfq_addenda_append_only BEFORE UPDATE OR DELETE ON "rfq_addenda" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER rfq_awards_append_only BEFORE UPDATE OR DELETE ON "rfq_awards" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER rfq_events_append_only BEFORE UPDATE OR DELETE ON "rfq_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- The lines of a request are what vendors priced: they change only while the request is a draft.
CREATE FUNCTION rfq_guard_lines() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM rfqs WHERE id = COALESCE(NEW.rfq_id, OLD.rfq_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'the lines of an issued request for quotation cannot change; send an addendum instead' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER rfq_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "rfq_lines" FOR EACH ROW EXECUTE FUNCTION rfq_guard_lines();--> statement-breakpoint
-- A submitted quote version never changes. It can be withdrawn (and then a new version is written); a draft can be removed.
CREATE FUNCTION rfq_guard_quote() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a submitted quote cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'submitted' AND NEW.status = 'withdrawn'
     AND NEW.rfq_id = OLD.rfq_id AND NEW.vendor_id = OLD.vendor_id AND NEW.version = OLD.version
     AND NEW.total = OLD.total AND NEW.subtotal = OLD.subtotal AND NEW.tax_total = OLD.tax_total
     AND NEW.payment_terms IS NOT DISTINCT FROM OLD.payment_terms AND NEW.delivery_terms IS NOT DISTINCT FROM OLD.delivery_terms
     AND NEW.valid_until IS NOT DISTINCT FROM OLD.valid_until AND NEW.notes IS NOT DISTINCT FROM OLD.notes THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a submitted quote version cannot be changed' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER rfq_quotes_guard BEFORE UPDATE OR DELETE ON "rfq_quotes" FOR EACH ROW EXECUTE FUNCTION rfq_guard_quote();--> statement-breakpoint
CREATE FUNCTION rfq_guard_quote_lines() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM rfq_quotes WHERE id = COALESCE(NEW.quote_id, OLD.quote_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'the lines of a submitted quote cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER rfq_quote_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "rfq_quote_lines" FOR EACH ROW EXECUTE FUNCTION rfq_guard_quote_lines();--> statement-breakpoint
-- Sealed quotes: may staff read the quotes of this request yet? Decided by the database's clock, and asked by the one read path.
CREATE FUNCTION rfq_quotes_open(p_rfq uuid) RETURNS boolean AS $$
  SELECT COALESCE((SELECT NOT sealed OR (opens_at IS NOT NULL AND now() >= opens_at) FROM rfqs WHERE id = p_rfq), false);
$$ LANGUAGE sql STABLE;
