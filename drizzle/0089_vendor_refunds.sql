CREATE TABLE "vendor_refund_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_refund_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"refund_id" uuid NOT NULL,
	"event" text NOT NULL,
	"reason_text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"vendor_id" uuid NOT NULL,
	"credit_entry_id" uuid NOT NULL,
	"credit_kind" text NOT NULL,
	"credit_no" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"method_id" uuid NOT NULL,
	"note" text,
	"reference" text,
	"received_on" date,
	"created_by" text,
	"posted_by" text,
	"posted_at" timestamp with time zone,
	"register_id" uuid,
	"ledger_entry_id" uuid,
	"bank_ledger_entry_id" bigint,
	"cancel_reason" text,
	"reversed_by" text,
	"reversed_at" timestamp with time zone,
	"reverse_reason" text,
	"reversal_register_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_refunds_status_chk" CHECK ("vendor_refunds"."status" IN ('pending','posted','cancelled','reversed')),
	CONSTRAINT "vendor_refunds_kind_chk" CHECK ("vendor_refunds"."credit_kind" IN ('payment','advance','credit_memo')),
	CONSTRAINT "vendor_refunds_amount_chk" CHECK ("vendor_refunds"."amount" > 0),
	CONSTRAINT "vendor_refunds_poster_chk" CHECK ("vendor_refunds"."posted_by" IS NULL OR "vendor_refunds"."posted_by" IS DISTINCT FROM "vendor_refunds"."created_by"),
	CONSTRAINT "vendor_refunds_posted_chk" CHECK ("vendor_refunds"."status" NOT IN ('posted','reversed') OR ("vendor_refunds"."number" IS NOT NULL AND "vendor_refunds"."reference" IS NOT NULL AND "vendor_refunds"."received_on" IS NOT NULL AND "vendor_refunds"."register_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "vendor_refund_events" ADD CONSTRAINT "vendor_refund_events_refund_id_vendor_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."vendor_refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_credit_entry_id_vendor_ledger_entries_id_fk" FOREIGN KEY ("credit_entry_id") REFERENCES "public"."vendor_ledger_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_refunds" ADD CONSTRAINT "vendor_refunds_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_refund_events_idx" ON "vendor_refund_events" USING btree ("refund_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_refunds_company_number_uidx" ON "vendor_refunds" USING btree ("company_id","number") WHERE "vendor_refunds"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "vendor_refunds_vendor_idx" ON "vendor_refunds" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE INDEX "vendor_refunds_credit_idx" ON "vendor_refunds" USING btree ("credit_entry_id") WHERE "vendor_refunds"."status" IN ('pending','posted');--> statement-breakpoint
CREATE TRIGGER vendor_refund_events_append_only BEFORE UPDATE OR DELETE ON "vendor_refund_events" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- A refund that has been booked is a record of money received: only its own reversal may change it, and it is never deleted.
CREATE FUNCTION vendor_refund_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('pending', 'cancelled') THEN
      RAISE EXCEPTION 'a booked vendor refund cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('posted', 'reversed', 'cancelled') AND (NEW.amount <> OLD.amount OR NEW.vendor_id <> OLD.vendor_id OR NEW.credit_entry_id <> OLD.credit_entry_id OR NEW.method_id <> OLD.method_id
     OR NEW.number IS DISTINCT FROM OLD.number OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.received_on IS DISTINCT FROM OLD.received_on) THEN
    RAISE EXCEPTION 'a booked vendor refund cannot be changed; reverse it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('reversed', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'this vendor refund is finished' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'posted' AND NEW.status NOT IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'a booked vendor refund can only be reversed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_refunds_guard BEFORE UPDATE OR DELETE ON "vendor_refunds" FOR EACH ROW EXECUTE FUNCTION vendor_refund_guard();
