CREATE TABLE "vendor_contract_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_contract_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"contract_id" uuid NOT NULL,
	"event" text NOT NULL,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_contract_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"product_id" text,
	"description" text NOT NULL,
	"specification" text,
	"unit" text DEFAULT 'each' NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT '0' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"max_quantity" numeric(14, 3),
	CONSTRAINT "vendor_contract_lines_chk" CHECK ("vendor_contract_lines"."unit_price" >= 0 AND "vendor_contract_lines"."discount_percent" BETWEEN 0 AND 100 AND ("vendor_contract_lines"."max_quantity" IS NULL OR "vendor_contract_lines"."max_quantity" > 0))
);
--> statement-breakpoint
CREATE TABLE "vendor_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"vendor_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"title" text NOT NULL,
	"currency" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"max_value" numeric(14, 2),
	"terms" text,
	"created_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"reject_reason" text,
	"close_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_contracts_status_chk" CHECK ("vendor_contracts"."status" IN ('draft','pending_approval','active','closed','cancelled')),
	CONSTRAINT "vendor_contracts_period_chk" CHECK ("vendor_contracts"."valid_from" <= "vendor_contracts"."valid_to"),
	CONSTRAINT "vendor_contracts_max_chk" CHECK ("vendor_contracts"."max_value" IS NULL OR "vendor_contracts"."max_value" > 0),
	CONSTRAINT "vendor_contracts_approver_chk" CHECK ("vendor_contracts"."approved_by" IS NULL OR "vendor_contracts"."approved_by" IS DISTINCT FROM "vendor_contracts"."created_by"),
	CONSTRAINT "vendor_contracts_active_chk" CHECK ("vendor_contracts"."status" NOT IN ('active','closed') OR "vendor_contracts"."number" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "contract_line_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_contract_events" ADD CONSTRAINT "vendor_contract_events_contract_id_vendor_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."vendor_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contract_lines" ADD CONSTRAINT "vendor_contract_lines_contract_id_vendor_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."vendor_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contract_lines" ADD CONSTRAINT "vendor_contract_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_category_id_procurement_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."procurement_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_contract_events_idx" ON "vendor_contract_events" USING btree ("contract_id","id");--> statement-breakpoint
CREATE INDEX "vendor_contract_lines_idx" ON "vendor_contract_lines" USING btree ("contract_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_contracts_company_number_uidx" ON "vendor_contracts" USING btree ("company_id","number") WHERE "vendor_contracts"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vendor_contracts_vendor_idx" ON "vendor_contracts" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE INDEX "vendor_contracts_company_status_idx" ON "vendor_contracts" USING btree ("company_id","status","valid_to");--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_contract_line_id_vendor_contract_lines_id_fk" FOREIGN KEY ("contract_line_id") REFERENCES "public"."vendor_contract_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_contract_id_vendor_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."vendor_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER vendor_contract_events_append_only BEFORE UPDATE OR DELETE ON "vendor_contract_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- Once a contract is approved, what was agreed does not change: a new price or period is a new contract.
CREATE FUNCTION vendor_contract_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'a contract that was approved cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('active', 'closed') AND (NEW.vendor_id <> OLD.vendor_id OR NEW.category_id <> OLD.category_id OR NEW.currency <> OLD.currency OR NEW.valid_from <> OLD.valid_from
     OR NEW.valid_to <> OLD.valid_to OR NEW.max_value IS DISTINCT FROM OLD.max_value OR NEW.number IS DISTINCT FROM OLD.number OR NEW.title <> OLD.title) THEN
    RAISE EXCEPTION 'an approved contract cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('closed', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'this contract is finished' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_contracts_guard BEFORE UPDATE OR DELETE ON "vendor_contracts" FOR EACH ROW EXECUTE FUNCTION vendor_contract_guard();--> statement-breakpoint
CREATE FUNCTION vendor_contract_guard_lines() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM vendor_contracts WHERE id = COALESCE(NEW.contract_id, OLD.contract_id);
  IF st IS NOT NULL AND st NOT IN ('draft', 'pending_approval') THEN
    RAISE EXCEPTION 'the lines of an approved contract cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_contract_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "vendor_contract_lines" FOR EACH ROW EXECUTE FUNCTION vendor_contract_guard_lines();--> statement-breakpoint
CREATE INDEX "purchase_order_lines_contract_idx" ON "purchase_order_lines" USING btree ("contract_line_id") WHERE "contract_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "purchase_orders_contract_idx" ON "purchase_orders" USING btree ("contract_id") WHERE "contract_id" IS NOT NULL;
