CREATE TABLE "vendor_payment_batch_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_payment_batch_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"batch_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_payment_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"method_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"execution_date" date NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"format" text,
	"content_sha256" text,
	"file_created_at" timestamp with time zone,
	"downloads" integer DEFAULT 0 NOT NULL,
	"first_cheque_no" text,
	"note" text,
	"created_by" text,
	"submitted_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"released_by" text,
	"released_at" timestamp with time zone,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"bank_reference" text,
	"cancel_reason" text,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_payment_batches_status_chk" CHECK ("vendor_payment_batches"."status" IN ('draft','pending_approval','approved','released','confirmed','cancelled')),
	CONSTRAINT "vendor_payment_batches_confirmer_chk" CHECK ("vendor_payment_batches"."confirmed_by" IS NULL OR "vendor_payment_batches"."confirmed_by" IS DISTINCT FROM "vendor_payment_batches"."released_by")
);
--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD COLUMN "cheque_no" text;--> statement-breakpoint
ALTER TABLE "vendor_payment_batch_events" ADD CONSTRAINT "vendor_payment_batch_events_batch_id_vendor_payment_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."vendor_payment_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_batches" ADD CONSTRAINT "vendor_payment_batches_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_batches" ADD CONSTRAINT "vendor_payment_batches_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_payment_batch_events_idx" ON "vendor_payment_batch_events" USING btree ("batch_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_payment_batches_number_uidx" ON "vendor_payment_batches" USING btree ("company_id","number") WHERE "vendor_payment_batches"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vendor_payment_batches_company_idx" ON "vendor_payment_batches" USING btree ("company_id","status","created_at");--> statement-breakpoint
ALTER TABLE "vendor_payment_vouchers" ADD CONSTRAINT "vendor_payment_vouchers_batch_id_vendor_payment_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."vendor_payment_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_payment_vouchers_batch_idx" ON "vendor_payment_vouchers" USING btree ("batch_id") WHERE "vendor_payment_vouchers"."batch_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_payment_vouchers_cheque_uidx" ON "vendor_payment_vouchers" USING btree ("method_id","cheque_no") WHERE "vendor_payment_vouchers"."cheque_no" IS NOT NULL AND "vendor_payment_vouchers"."status" IN ('approved','paid');--> statement-breakpoint
CREATE TRIGGER vendor_payment_batch_events_append_only BEFORE UPDATE OR DELETE ON "vendor_payment_batch_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- A confirmed run is a record of money that left: it cannot be changed or deleted.
CREATE FUNCTION vendor_payment_batch_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'a payment run that went further than a draft cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('confirmed', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'this payment run is finished' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'confirmed' AND (NEW.method_id <> OLD.method_id OR NEW.total <> OLD.total OR NEW.item_count <> OLD.item_count OR NEW.bank_reference IS DISTINCT FROM OLD.bank_reference OR NEW.number IS DISTINCT FROM OLD.number) THEN
    RAISE EXCEPTION 'a confirmed payment run cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_payment_batches_guard BEFORE UPDATE OR DELETE ON "vendor_payment_batches" FOR EACH ROW EXECUTE FUNCTION vendor_payment_batch_guard();
