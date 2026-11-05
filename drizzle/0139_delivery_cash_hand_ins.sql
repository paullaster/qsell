CREATE TABLE "cash_hand_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"rider_id" uuid NOT NULL,
	"status" text NOT NULL,
	"expected_amount" numeric(14, 2) NOT NULL,
	"counted_amount" numeric(14, 2) NOT NULL,
	"difference" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"custody_bank_account_id" uuid NOT NULL,
	"to_bank_account_id" uuid NOT NULL,
	"variance_gl_account_id" uuid,
	"witness_user_id" text NOT NULL,
	"witness_name" text NOT NULL,
	"note" text,
	"counted_by" text NOT NULL,
	"approved_by" text,
	"decision_reason" text,
	"register_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "cash_hand_ins_status_chk" CHECK ("cash_hand_ins"."status" IN ('pending_approval','posted','rejected')),
	CONSTRAINT "cash_hand_ins_amounts_chk" CHECK ("cash_hand_ins"."expected_amount" > 0 AND "cash_hand_ins"."counted_amount" >= 0 AND "cash_hand_ins"."difference" = "cash_hand_ins"."counted_amount" - "cash_hand_ins"."expected_amount"),
	CONSTRAINT "cash_hand_ins_accounts_chk" CHECK ("cash_hand_ins"."custody_bank_account_id" <> "cash_hand_ins"."to_bank_account_id"),
	CONSTRAINT "cash_hand_ins_variance_chk" CHECK ("cash_hand_ins"."difference" = 0 OR ("cash_hand_ins"."variance_gl_account_id" IS NOT NULL AND "cash_hand_ins"."note" IS NOT NULL)),
	CONSTRAINT "cash_hand_ins_decided_chk" CHECK (("cash_hand_ins"."status" = 'pending_approval') = ("cash_hand_ins"."decided_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "cash_custody_entries" ADD COLUMN "hand_in_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_door_settings" ADD COLUMN "variance_limit" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_door_settings" ADD COLUMN "variance_gl_account_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_hand_ins" ADD CONSTRAINT "cash_hand_ins_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_hand_ins" ADD CONSTRAINT "cash_hand_ins_rider_id_delivery_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."delivery_riders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_hand_ins" ADD CONSTRAINT "cash_hand_ins_custody_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("custody_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_hand_ins" ADD CONSTRAINT "cash_hand_ins_to_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("to_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_hand_ins" ADD CONSTRAINT "cash_hand_ins_variance_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("variance_gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_hand_ins_number_uidx" ON "cash_hand_ins" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "cash_hand_ins_rider_idx" ON "cash_hand_ins" USING btree ("rider_id","created_at");--> statement-breakpoint
CREATE INDEX "cash_hand_ins_status_idx" ON "cash_hand_ins" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_hand_ins_one_pending_uidx" ON "cash_hand_ins" USING btree ("rider_id") WHERE "cash_hand_ins"."status" = 'pending_approval';--> statement-breakpoint
ALTER TABLE "cash_custody_entries" ADD CONSTRAINT "cash_custody_entries_hand_in_id_cash_hand_ins_id_fk" FOREIGN KEY ("hand_in_id") REFERENCES "public"."cash_hand_ins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_door_settings" ADD CONSTRAINT "delivery_door_settings_variance_gl_account_id_gl_accounts_id_fk" FOREIGN KEY ("variance_gl_account_id") REFERENCES "public"."gl_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_custody_entries" ADD CONSTRAINT "cash_custody_handin_chk" CHECK ("cash_custody_entries"."kind" <> 'handed_in' OR "cash_custody_entries"."hand_in_id" IS NOT NULL);--> statement-breakpoint
-- A hand-in is kept for good. While it waits it may be approved or refused; once decided it is never changed, and none is ever removed.
CREATE FUNCTION cash_hand_ins_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash hand-ins are kept; they cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'a decided cash hand-in cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.rider_id IS DISTINCT FROM OLD.rider_id OR NEW.expected_amount IS DISTINCT FROM OLD.expected_amount
     OR NEW.counted_amount IS DISTINCT FROM OLD.counted_amount OR NEW.difference IS DISTINCT FROM OLD.difference
     OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.custody_bank_account_id IS DISTINCT FROM OLD.custody_bank_account_id
     OR NEW.to_bank_account_id IS DISTINCT FROM OLD.to_bank_account_id OR NEW.variance_gl_account_id IS DISTINCT FROM OLD.variance_gl_account_id
     OR NEW.witness_user_id IS DISTINCT FROM OLD.witness_user_id OR NEW.counted_by IS DISTINCT FROM OLD.counted_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'only the decision on a cash hand-in can change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER cash_hand_ins_guard_trg BEFORE UPDATE OR DELETE ON "cash_hand_ins" FOR EACH ROW EXECUTE FUNCTION cash_hand_ins_guard();
