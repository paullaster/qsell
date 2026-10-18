CREATE TABLE "bill_invoice_payments" (
	"transaction_id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"method_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"account_reference" text NOT NULL,
	"customer_id" uuid,
	"billed_name" text NOT NULL,
	"phone_masked" text NOT NULL,
	"invoice_name" text NOT NULL,
	"period" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"due_date" date NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"failure_reason" text,
	"paid_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"paid_at" timestamp with time zone,
	"last_transaction_id" uuid,
	"send_operation_id" uuid,
	"cancel_operation_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"ack_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bill_invoices_amount_chk" CHECK ("bill_invoices"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "bill_invoice_payments" ADD CONSTRAINT "bill_invoice_payments_transaction_id_provider_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."provider_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_invoice_payments" ADD CONSTRAINT "bill_invoice_payments_invoice_id_bill_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."bill_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_invoices" ADD CONSTRAINT "bill_invoices_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_invoices" ADD CONSTRAINT "bill_invoices_provider_id_payment_provider_configs_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_invoices" ADD CONSTRAINT "bill_invoices_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_invoices" ADD CONSTRAINT "bill_invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_invoices" ADD CONSTRAINT "bill_invoices_send_operation_id_provider_operations_id_fk" FOREIGN KEY ("send_operation_id") REFERENCES "public"."provider_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_invoices" ADD CONSTRAINT "bill_invoices_cancel_operation_id_provider_operations_id_fk" FOREIGN KEY ("cancel_operation_id") REFERENCES "public"."provider_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_invoice_payments_invoice_idx" ON "bill_invoice_payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_invoices_ref_uidx" ON "bill_invoices" USING btree ("provider_id","reference");--> statement-breakpoint
CREATE INDEX "bill_invoices_account_idx" ON "bill_invoices" USING btree ("provider_id","account_reference","status");--> statement-breakpoint
CREATE INDEX "bill_invoices_status_idx" ON "bill_invoices" USING btree ("company_id","status","created_at");--> statement-breakpoint
-- An invoice keeps what it said: only its status, what has been paid and the acknowledgement move. None is deleted.
CREATE FUNCTION finance_guard_bill_invoice() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bill Manager invoices are kept; cancel them' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.reference <> OLD.reference OR NEW.account_reference <> OLD.account_reference OR NEW.amount <> OLD.amount
     OR NEW.provider_id <> OLD.provider_id OR NEW.method_id <> OLD.method_id OR NEW.due_date <> OLD.due_date OR NEW.billed_name <> OLD.billed_name THEN
    RAISE EXCEPTION 'an invoice keeps what it said' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('paid', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a % invoice cannot change status', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER bill_invoices_guard BEFORE UPDATE OR DELETE ON "bill_invoices" FOR EACH ROW EXECUTE FUNCTION finance_guard_bill_invoice();--> statement-breakpoint
CREATE TRIGGER bill_invoice_payments_append_only BEFORE UPDATE OR DELETE ON "bill_invoice_payments" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();
