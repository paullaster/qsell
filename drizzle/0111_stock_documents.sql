CREATE TABLE "stock_document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" text NOT NULL,
	"quantity" numeric(14, 3) DEFAULT 0 NOT NULL,
	"shipped_quantity" numeric(14, 3) DEFAULT 0 NOT NULL,
	"received_quantity" numeric(14, 3) DEFAULT 0 NOT NULL,
	"written_off_quantity" numeric(14, 3) DEFAULT 0 NOT NULL,
	"returned_quantity" numeric(14, 3) DEFAULT 0 NOT NULL,
	"unit_cost" numeric(14, 4) DEFAULT '0' NOT NULL,
	"expected_quantity" numeric(14, 3),
	"counted_quantity" numeric(14, 3),
	"counted_by" text,
	"counted_at" timestamp with time zone,
	"variance_quantity" numeric(14, 3),
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "stock_document_lines_quantity_chk" CHECK ("stock_document_lines"."quantity" >= 0 AND "stock_document_lines"."shipped_quantity" >= 0 AND "stock_document_lines"."received_quantity" >= 0 AND "stock_document_lines"."written_off_quantity" >= 0 AND "stock_document_lines"."returned_quantity" >= 0),
	CONSTRAINT "stock_document_lines_shipped_chk" CHECK ("stock_document_lines"."shipped_quantity" <= "stock_document_lines"."quantity"),
	CONSTRAINT "stock_document_lines_accounted_chk" CHECK ("stock_document_lines"."received_quantity" + "stock_document_lines"."written_off_quantity" + "stock_document_lines"."returned_quantity" <= "stock_document_lines"."shipped_quantity"),
	CONSTRAINT "stock_document_lines_counted_chk" CHECK ("stock_document_lines"."counted_quantity" IS NULL OR "stock_document_lines"."counted_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"from_location_id" uuid,
	"to_location_id" uuid,
	"transit_location_id" uuid,
	"count_mode" text,
	"blind" boolean DEFAULT false NOT NULL,
	"snapshot_movement_id" bigint,
	"reason_code" text,
	"note" text DEFAULT '' NOT NULL,
	"source_type" text,
	"source_id" text,
	"created_by" text NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"shipped_by" text,
	"shipped_at" timestamp with time zone,
	"last_received_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_documents_kind_chk" CHECK ("stock_documents"."kind" IN ('transfer','count')),
	CONSTRAINT "stock_documents_state_chk" CHECK ("stock_documents"."state" IN ('draft','requested','approved','shipped','partly_received','received','closed','cancelled','counting','counted','posted')),
	CONSTRAINT "stock_documents_transfer_places_chk" CHECK ("stock_documents"."kind" <> 'transfer' OR ("stock_documents"."from_location_id" IS NOT NULL AND "stock_documents"."to_location_id" IS NOT NULL AND "stock_documents"."from_location_id" <> "stock_documents"."to_location_id")),
	CONSTRAINT "stock_documents_count_place_chk" CHECK ("stock_documents"."kind" <> 'count' OR ("stock_documents"."from_location_id" IS NOT NULL AND "stock_documents"."count_mode" IN ('cycle','full')))
);
--> statement-breakpoint
ALTER TABLE "stock_settings" ADD COLUMN "transfer_requires_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_settings" ADD COLUMN "count_approval_value" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_document_id_stock_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."stock_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_from_location_id_stock_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_to_location_id_stock_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_transit_location_id_stock_locations_id_fk" FOREIGN KEY ("transit_location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_document_lines_product_uidx" ON "stock_document_lines" USING btree ("document_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_document_lines_no_uidx" ON "stock_document_lines" USING btree ("document_id","line_no");--> statement-breakpoint
CREATE INDEX "stock_document_lines_product_idx" ON "stock_document_lines" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_documents_company_number_uidx" ON "stock_documents" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "stock_documents_kind_state_idx" ON "stock_documents" USING btree ("company_id","kind","state","created_at");--> statement-breakpoint
CREATE INDEX "stock_documents_from_idx" ON "stock_documents" USING btree ("from_location_id");--> statement-breakpoint
CREATE INDEX "stock_documents_to_idx" ON "stock_documents" USING btree ("to_location_id");--> statement-breakpoint
CREATE INDEX "stock_documents_open_transit_idx" ON "stock_documents" USING btree ("transit_location_id") WHERE "stock_documents"."transit_location_id" IS NOT NULL;--> statement-breakpoint
-- A finished document never changes, and the lines of a document that has left draft are never removed: corrections are new documents.
CREATE FUNCTION stock_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock documents are not deleted: cancel them instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state IN ('received', 'closed', 'cancelled', 'posted') THEN
    RAISE EXCEPTION 'stock document % is % and cannot change', OLD.number, OLD.state USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER stock_documents_no_change_when_finished BEFORE UPDATE OR DELETE ON "stock_documents" FOR EACH ROW EXECUTE FUNCTION stock_documents_guard();--> statement-breakpoint
CREATE FUNCTION stock_document_lines_guard() RETURNS trigger AS $$
DECLARE
  st text;
  doc_number text;
  doc uuid;
BEGIN
  doc := CASE WHEN TG_OP = 'INSERT' THEN NEW.document_id ELSE OLD.document_id END;
  SELECT state, number INTO st, doc_number FROM stock_documents WHERE id = doc;
  IF st IN ('received', 'closed', 'cancelled', 'posted') THEN
    RAISE EXCEPTION 'stock document % is % and its lines cannot change', doc_number, st USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' AND st NOT IN ('draft') THEN
    RAISE EXCEPTION 'lines of stock document % cannot be removed once it has left draft', doc_number USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER stock_document_lines_guard_t BEFORE INSERT OR UPDATE OR DELETE ON "stock_document_lines" FOR EACH ROW EXECUTE FUNCTION stock_document_lines_guard();
