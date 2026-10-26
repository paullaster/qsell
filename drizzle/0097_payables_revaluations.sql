CREATE TABLE "payables_revaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"rates" jsonb NOT NULL,
	"net" numeric(14, 2) NOT NULL,
	"groups" jsonb NOT NULL,
	"reversed_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payables_revaluations" ADD CONSTRAINT "payables_revaluations_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payables_revaluations_day_uidx" ON "payables_revaluations" USING btree ("company_id","as_of");--> statement-breakpoint
CREATE INDEX "payables_revaluations_open_idx" ON "payables_revaluations" USING btree ("company_id") WHERE "payables_revaluations"."reversed_at" IS NULL;--> statement-breakpoint
-- A revaluation is kept; only its undoing is written onto it.
CREATE FUNCTION payables_guard_revaluation() RETURNS trigger AS $$
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
CREATE TRIGGER payables_revaluations_guard BEFORE UPDATE OR DELETE ON "payables_revaluations" FOR EACH ROW EXECUTE FUNCTION payables_guard_revaluation();
