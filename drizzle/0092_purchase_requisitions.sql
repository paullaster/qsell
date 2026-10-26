CREATE TABLE "purchase_requisition_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_requisition_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"requisition_id" uuid NOT NULL,
	"event" text NOT NULL,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_requisition_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisition_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" text,
	"description" text NOT NULL,
	"specification" text,
	"quantity" numeric(14, 3) NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"estimated_unit_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_requisition_lines_qty_chk" CHECK ("purchase_requisition_lines"."quantity" > 0 AND "purchase_requisition_lines"."estimated_unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_requisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"category_id" uuid NOT NULL,
	"branch_id" uuid,
	"needed_by" date,
	"currency" text NOT NULL,
	"estimated_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"requester_id" text,
	"submitted_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"cancel_reason" text,
	"converted_type" text,
	"converted_id" uuid,
	"converted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_requisitions_status_chk" CHECK ("purchase_requisitions"."status" IN ('draft','submitted','approved','rejected','converted','cancelled')),
	CONSTRAINT "purchase_requisitions_decider_chk" CHECK ("purchase_requisitions"."decided_by" IS NULL OR "purchase_requisitions"."decided_by" IS DISTINCT FROM "purchase_requisitions"."requester_id"),
	CONSTRAINT "purchase_requisitions_converted_chk" CHECK ("purchase_requisitions"."status" <> 'converted' OR ("purchase_requisitions"."converted_type" IS NOT NULL AND "purchase_requisitions"."converted_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "purchase_requisition_events" ADD CONSTRAINT "purchase_requisition_events_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_requisition_id_purchase_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."purchase_requisitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisition_lines" ADD CONSTRAINT "purchase_requisition_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_category_id_procurement_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."procurement_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_requisition_events_idx" ON "purchase_requisition_events" USING btree ("requisition_id","id");--> statement-breakpoint
CREATE INDEX "purchase_requisition_lines_idx" ON "purchase_requisition_lines" USING btree ("requisition_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_requisitions_company_number_uidx" ON "purchase_requisitions" USING btree ("company_id","number") WHERE "purchase_requisitions"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "purchase_requisitions_company_status_idx" ON "purchase_requisitions" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "purchase_requisitions_requester_idx" ON "purchase_requisitions" USING btree ("requester_id","created_at");--> statement-breakpoint
CREATE TRIGGER purchase_requisition_events_append_only BEFORE UPDATE OR DELETE ON "purchase_requisition_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- Once a requisition has been submitted, what was asked for does not change; a change is a new requisition.
CREATE FUNCTION purchase_requisition_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'a requisition that was submitted cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status NOT IN ('draft') AND (NEW.title <> OLD.title OR NEW.category_id <> OLD.category_id OR NEW.currency <> OLD.currency OR NEW.estimated_total <> OLD.estimated_total
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.requester_id IS DISTINCT FROM OLD.requester_id) THEN
    RAISE EXCEPTION 'a submitted requisition cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('rejected', 'converted', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'this requisition is finished' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER purchase_requisitions_guard BEFORE UPDATE OR DELETE ON "purchase_requisitions" FOR EACH ROW EXECUTE FUNCTION purchase_requisition_guard();--> statement-breakpoint
CREATE FUNCTION purchase_requisition_guard_lines() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM purchase_requisitions WHERE id = COALESCE(NEW.requisition_id, OLD.requisition_id);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'the lines of a submitted requisition cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER purchase_requisition_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "purchase_requisition_lines" FOR EACH ROW EXECUTE FUNCTION purchase_requisition_guard_lines();
