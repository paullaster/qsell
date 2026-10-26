CREATE TABLE "landed_cost_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "landed_cost_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"landed_cost_id" uuid NOT NULL,
	"event" text NOT NULL,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landed_cost_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"landed_cost_id" uuid NOT NULL,
	"rgn_line_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"share" numeric(14, 2) NOT NULL,
	"cost_before" numeric(14, 2),
	"cost_after" numeric(14, 2),
	"capitalised" numeric(14, 2)
);
--> statement-breakpoint
CREATE TABLE "landed_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"rgn_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"reference" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"method" text DEFAULT 'value' NOT NULL,
	"created_by" text,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landed_costs_status_chk" CHECK ("landed_costs"."status" IN ('draft','posted','cancelled')),
	CONSTRAINT "landed_costs_method_chk" CHECK ("landed_costs"."method" IN ('value','quantity')),
	CONSTRAINT "landed_costs_amount_chk" CHECK ("landed_costs"."amount" > 0),
	CONSTRAINT "landed_costs_poster_chk" CHECK ("landed_costs"."posted_by" IS NULL OR "landed_costs"."posted_by" IS DISTINCT FROM "landed_costs"."created_by"),
	CONSTRAINT "landed_costs_posted_chk" CHECK ("landed_costs"."status" <> 'posted' OR ("landed_costs"."number" IS NOT NULL AND "landed_costs"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "landed_cost_events" ADD CONSTRAINT "landed_cost_events_landed_cost_id_landed_costs_id_fk" FOREIGN KEY ("landed_cost_id") REFERENCES "public"."landed_costs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_landed_cost_id_landed_costs_id_fk" FOREIGN KEY ("landed_cost_id") REFERENCES "public"."landed_costs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_lines" ADD CONSTRAINT "landed_cost_lines_rgn_line_id_rgn_lines_id_fk" FOREIGN KEY ("rgn_line_id") REFERENCES "public"."rgn_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_rgn_id_rgns_id_fk" FOREIGN KEY ("rgn_id") REFERENCES "public"."rgns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_costs" ADD CONSTRAINT "landed_costs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "landed_cost_events_idx" ON "landed_cost_events" USING btree ("landed_cost_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "landed_cost_lines_uidx" ON "landed_cost_lines" USING btree ("landed_cost_id","rgn_line_id");--> statement-breakpoint
CREATE INDEX "landed_cost_lines_rgn_line_idx" ON "landed_cost_lines" USING btree ("rgn_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "landed_costs_company_number_uidx" ON "landed_costs" USING btree ("company_id","number") WHERE "landed_costs"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "landed_costs_reference_uidx" ON "landed_costs" USING btree ("rgn_id","kind",lower("reference")) WHERE "landed_costs"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "landed_costs_rgn_idx" ON "landed_costs" USING btree ("rgn_id");--> statement-breakpoint
CREATE TRIGGER landed_cost_events_append_only BEFORE UPDATE OR DELETE ON "landed_cost_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- A posted charge changed what goods cost: it is a record, never changed or deleted.
CREATE FUNCTION landed_cost_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'a posted landed cost cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('posted', 'cancelled') AND (NEW.status <> OLD.status OR NEW.amount <> OLD.amount OR NEW.rgn_id <> OLD.rgn_id OR NEW.method <> OLD.method
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.reference <> OLD.reference OR NEW.kind <> OLD.kind) THEN
    RAISE EXCEPTION 'a posted or cancelled landed cost cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER landed_costs_guard BEFORE UPDATE OR DELETE ON "landed_costs" FOR EACH ROW EXECUTE FUNCTION landed_cost_guard();--> statement-breakpoint
CREATE FUNCTION landed_cost_guard_lines() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM landed_costs WHERE id = COALESCE(NEW.landed_cost_id, OLD.landed_cost_id);
  IF st IS NOT NULL AND st <> 'draft' AND NOT (TG_OP = 'UPDATE' AND st = 'posted' AND OLD.cost_after IS NULL) THEN
    RAISE EXCEPTION 'the lines of a posted landed cost cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER landed_cost_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "landed_cost_lines" FOR EACH ROW EXECUTE FUNCTION landed_cost_guard_lines();
