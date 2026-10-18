CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"effective_on" date NOT NULL,
	"rate" numeric(24, 8) NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_positive_chk" CHECK ("exchange_rates"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "fx_revaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"rates" jsonb NOT NULL,
	"net" numeric(20, 4) NOT NULL,
	"groups" jsonb NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_day_uidx" ON "exchange_rates" USING btree ("company_id","currency","effective_on");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_revaluations_day_uidx" ON "fx_revaluations" USING btree ("company_id","as_of");--> statement-breakpoint
-- A rate that has stood for a day cannot be changed: documents dated on or after it have been valued by it. Today's and future
-- rates may still be corrected or removed.
CREATE FUNCTION finance_guard_exchange_rate() RETURNS trigger AS $$
BEGIN
  IF OLD.effective_on < (now() AT TIME ZONE 'Africa/Nairobi')::date THEN
    RAISE EXCEPTION 'an exchange rate from a day that has passed cannot be changed or removed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.currency <> OLD.currency OR NEW.effective_on <> OLD.effective_on OR NEW.company_id <> OLD.company_id) THEN
    RAISE EXCEPTION 'a rate keeps its currency and its day' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER exchange_rates_guard BEFORE UPDATE OR DELETE ON "exchange_rates" FOR EACH ROW EXECUTE FUNCTION finance_guard_exchange_rate();--> statement-breakpoint
-- A revaluation is kept; only its undoing is written onto it.
CREATE FUNCTION finance_guard_fx_revaluation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'revaluations are kept' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.as_of <> OLD.as_of OR NEW.net <> OLD.net OR NEW.rates <> OLD.rates OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'a revaluation keeps what it said' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at THEN
    RAISE EXCEPTION 'a revaluation that was undone stays undone' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER fx_revaluations_guard BEFORE UPDATE OR DELETE ON "fx_revaluations" FOR EACH ROW EXECUTE FUNCTION finance_guard_fx_revaluation();
