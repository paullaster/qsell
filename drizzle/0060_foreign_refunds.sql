ALTER TABLE "refund_requests" ADD COLUMN "rate" text DEFAULT '1' NOT NULL;
--> statement-breakpoint
-- The rate a refund is booked at is fixed once the refund has been set aside in the books; before that (a refund approved before
-- the books went live) the go-live may still value it.
CREATE OR REPLACE FUNCTION finance_guard_refund() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refunds cannot be deleted; cancel them' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('paid','cancelled') AND (NEW.status <> OLD.status OR NEW.amount <> OLD.amount OR NEW.rate <> OLD.rate) THEN
    RAISE EXCEPTION 'a % refund cannot change', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'rejected' AND (NEW.status NOT IN ('rejected','draft') OR NEW.amount <> OLD.amount) THEN
    RAISE EXCEPTION 'a % refund cannot change', OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.amount <> OLD.amount OR NEW.customer_id <> OLD.customer_id OR NEW.source_kind <> OLD.source_kind
      OR NEW.source_id <> OLD.source_id OR NEW.currency <> OLD.currency OR NEW.number <> OLD.number) THEN
    RAISE EXCEPTION 'a refund that has been submitted keeps its amount, customer and source' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.reserve_register_id IS NOT NULL AND NEW.rate <> OLD.rate THEN
    RAISE EXCEPTION 'the rate of a refund that is in the books cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
