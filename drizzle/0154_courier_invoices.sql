CREATE TABLE "courier_invoice_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"cost_id" uuid NOT NULL,
	"matched_by" text NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"courier_name" text NOT NULL,
	"invoice_no" text NOT NULL,
	"invoice_date" date NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "courier_invoices_total_chk" CHECK ("courier_invoices"."total" > 0),
	CONSTRAINT "courier_invoices_void_chk" CHECK (("courier_invoices"."voided_at" IS NULL) = ("courier_invoices"."voided_by" IS NULL) AND ("courier_invoices"."voided_at" IS NULL) = ("courier_invoices"."void_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "courier_invoice_charges" ADD CONSTRAINT "courier_invoice_charges_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_invoice_charges" ADD CONSTRAINT "courier_invoice_charges_invoice_id_courier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."courier_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_invoice_charges" ADD CONSTRAINT "courier_invoice_charges_cost_id_delivery_costs_id_fk" FOREIGN KEY ("cost_id") REFERENCES "public"."delivery_costs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courier_invoices" ADD CONSTRAINT "courier_invoices_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "courier_invoice_charges_cost_uidx" ON "courier_invoice_charges" USING btree ("cost_id");--> statement-breakpoint
CREATE INDEX "courier_invoice_charges_invoice_idx" ON "courier_invoice_charges" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "courier_invoices_live_uidx" ON "courier_invoices" USING btree ("company_id",lower("courier_name"),lower("invoice_no")) WHERE "courier_invoices"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "courier_invoices_company_idx" ON "courier_invoices" USING btree ("company_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE FUNCTION courier_invoices_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A courier invoice cannot be deleted; void it with a reason.';
  END IF;
  -- Only voiding may change an invoice, once: what it says stays as it was typed.
  IF OLD.voided_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.courier_name IS DISTINCT FROM OLD.courier_name OR NEW.invoice_no IS DISTINCT FROM OLD.invoice_no
     OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A courier invoice cannot be changed once typed in; it can only be voided.';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER courier_invoices_guard BEFORE UPDATE OR DELETE ON courier_invoices FOR EACH ROW EXECUTE FUNCTION courier_invoices_guard();
