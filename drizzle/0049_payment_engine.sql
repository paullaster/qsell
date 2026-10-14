CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_ip" text,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_text" text DEFAULT '' NOT NULL,
	"raw_body" jsonb,
	"body_hash" text NOT NULL,
	"claim" jsonb,
	"operation_id" uuid,
	"attempt_id" uuid,
	"state" text DEFAULT 'received' NOT NULL,
	"failure_code" text,
	"failure_reason" text,
	"platform_reference" text,
	"amount" numeric(20, 4),
	"duplicate_of" uuid,
	"verified_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"method_id" uuid,
	"operation" text NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"idempotency_key" text NOT NULL,
	"originator_id" text,
	"conversation_id" text,
	"platform_reference" text,
	"subject_type" text,
	"subject_id" text,
	"amount" numeric(20, 4),
	"currency" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_code" text,
	"failure_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"requested_by" text,
	"origin" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"method_id" uuid,
	"kind" text NOT NULL,
	"platform_reference" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"payer_masked" text,
	"payer_hash" text,
	"shortcode" text,
	"account_reference" text,
	"occurred_at" timestamp with time zone,
	"state" text DEFAULT 'claimed' NOT NULL,
	"verified_by" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_at" timestamp with time zone,
	"consumed_type" text,
	"consumed_id" text,
	"consumed_at" timestamp with time zone,
	"failure_code" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_audit_log" ADD COLUMN "provider_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_audit_log" ADD COLUMN "operation_id" uuid;--> statement-breakpoint
ALTER TABLE "integration_audit_log" ADD COLUMN "source_ip" text;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_provider_id_payment_provider_configs_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_operation_id_provider_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."provider_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_provider_id_payment_provider_configs_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_provider_id_payment_provider_configs_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_provider_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_transactions" ADD CONSTRAINT "provider_transactions_method_id_payment_methods_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payment_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_events_provider_idx" ON "provider_events" USING btree ("provider_id","kind","state");--> statement-breakpoint
CREATE INDEX "provider_events_ref_idx" ON "provider_events" USING btree ("platform_reference");--> statement-breakpoint
CREATE INDEX "provider_events_hash_idx" ON "provider_events" USING btree ("provider_id","body_hash");--> statement-breakpoint
CREATE INDEX "provider_events_operation_idx" ON "provider_events" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "provider_events_created_idx" ON "provider_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_operations_idem_uidx" ON "provider_operations" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "provider_operations_provider_idx" ON "provider_operations" USING btree ("provider_id","operation","status");--> statement-breakpoint
CREATE INDEX "provider_operations_originator_idx" ON "provider_operations" USING btree ("originator_id");--> statement-breakpoint
CREATE INDEX "provider_operations_conversation_idx" ON "provider_operations" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "provider_operations_subject_idx" ON "provider_operations" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "provider_operations_due_idx" ON "provider_operations" USING btree ("next_attempt_at") WHERE "provider_operations"."status" IN ('queued','submitted','accepted','timed_out','in_doubt');--> statement-breakpoint
CREATE UNIQUE INDEX "provider_transactions_ref_uidx" ON "provider_transactions" USING btree ("provider_id","platform_reference");--> statement-breakpoint
CREATE INDEX "provider_transactions_state_idx" ON "provider_transactions" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "provider_transactions_occurred_idx" ON "provider_transactions" USING btree ("provider_id","occurred_at");--> statement-breakpoint
CREATE INDEX "integration_audit_operation_idx" ON "integration_audit_log" USING btree ("operation_id");--> statement-breakpoint
-- What a platform sent us is a fact; money counted once stays counted once; nothing here is deleted.
CREATE FUNCTION finance_guard_provider_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider events are kept; they cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.raw_text <> OLD.raw_text OR NEW.body_hash <> OLD.body_hash OR NEW.kind <> OLD.kind
     OR NEW.provider_id <> OLD.provider_id OR NEW.headers IS DISTINCT FROM OLD.headers
     OR NEW.source_ip IS DISTINCT FROM OLD.source_ip OR NEW.created_at <> OLD.created_at
     OR NEW.claim IS DISTINCT FROM OLD.claim THEN
    RAISE EXCEPTION 'what a platform sent cannot be edited' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER provider_events_guard BEFORE UPDATE OR DELETE ON "provider_events" FOR EACH ROW EXECUTE FUNCTION finance_guard_provider_event();--> statement-breakpoint
CREATE FUNCTION finance_guard_provider_transaction() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider transactions are kept; they cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.platform_reference <> OLD.platform_reference OR NEW.amount <> OLD.amount
     OR NEW.provider_id <> OLD.provider_id OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'a provider transaction keeps its reference, amount and provider' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND (NEW.consumed_type IS DISTINCT FROM OLD.consumed_type OR NEW.consumed_id IS DISTINCT FROM OLD.consumed_id
     OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'a transaction that was counted cannot be counted again or changed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER provider_transactions_guard BEFORE UPDATE OR DELETE ON "provider_transactions" FOR EACH ROW EXECUTE FUNCTION finance_guard_provider_transaction();--> statement-breakpoint
CREATE FUNCTION finance_guard_provider_operation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider operations are kept; they cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.operation <> OLD.operation OR NEW.provider_id <> OLD.provider_id OR NEW.idempotency_key <> OLD.idempotency_key
     OR (OLD.originator_id IS NOT NULL AND NEW.originator_id IS DISTINCT FROM OLD.originator_id)
     OR NEW.amount IS DISTINCT FROM OLD.amount THEN
    RAISE EXCEPTION 'a provider operation keeps what it was asked to do' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('succeeded','failed','cancelled','rejected') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a finished provider operation cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER provider_operations_guard BEFORE UPDATE OR DELETE ON "provider_operations" FOR EACH ROW EXECUTE FUNCTION finance_guard_provider_operation();
