CREATE TABLE "shift_close_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"declared_cash" numeric(14, 2) NOT NULL,
	"closing_counted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_cash" numeric(14, 2) NOT NULL,
	"variance" numeric(14, 2) NOT NULL,
	"variance_reason" text NOT NULL,
	"closing_figures" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "shift_close_requests_status_chk" CHECK ("shift_close_requests"."status" IN ('pending', 'approved', 'rejected', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_status_chk";--> statement-breakpoint
ALTER TABLE "shifts" DROP CONSTRAINT "shifts_closed_chk";--> statement-breakpoint
DROP INDEX "shifts_one_open_per_register_uidx";--> statement-breakpoint
DROP INDEX "shifts_one_open_per_person_uidx";--> statement-breakpoint
ALTER TABLE "shift_settings" ADD COLUMN "supervisor_close" text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_close_requests" ADD CONSTRAINT "shift_close_requests_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shift_close_requests_one_pending_uidx" ON "shift_close_requests" USING btree ("shift_id") WHERE "shift_close_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "shift_close_requests_shift_idx" ON "shift_close_requests" USING btree ("shift_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_open_per_register_uidx" ON "shifts" USING btree ("register_id") WHERE "shifts"."status" IN ('open', 'closing');--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_open_per_person_uidx" ON "shifts" USING btree ("opened_by") WHERE "shifts"."status" IN ('open', 'closing');--> statement-breakpoint
ALTER TABLE "shift_settings" ADD CONSTRAINT "shift_settings_supervisor_close_chk" CHECK ("shift_settings"."supervisor_close" IN ('direct', 'approval'));--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_status_chk" CHECK ("shifts"."status" IN ('open', 'closing', 'closed'));--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_chk" CHECK (("shifts"."status" IN ('open', 'closing') AND "shifts"."closed_at" IS NULL) OR ("shifts"."status" = 'closed' AND "shifts"."closed_at" IS NOT NULL AND "shifts"."declared_cash" IS NOT NULL AND "shifts"."z_number" IS NOT NULL));--> statement-breakpoint
-- A decided close request is a record of what was asked and what was decided: it is never deleted, its figures never change, and only a pending one can be decided.
CREATE FUNCTION shift_close_requests_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A shift close request is never deleted' USING ERRCODE = '23001';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'A decided shift close request cannot be changed' USING ERRCODE = '23001';
  END IF;
  IF NEW.shift_id <> OLD.shift_id OR NEW.declared_cash <> OLD.declared_cash OR NEW.expected_cash <> OLD.expected_cash OR NEW.variance <> OLD.variance OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'The figures of a shift close request cannot be changed' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER shift_close_requests_guard_trg BEFORE UPDATE OR DELETE ON shift_close_requests FOR EACH ROW EXECUTE FUNCTION shift_close_requests_guard();
