DROP INDEX "shifts_z_number_uidx";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "is_walk_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_tenders" ADD COLUMN "method_kind" text;--> statement-breakpoint
ALTER TABLE "order_tenders" ADD COLUMN "handed_over" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "order_tenders" ADD COLUMN "change_due" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "order_tenders" ADD COLUMN "external_reference" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shift_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_one_walk_in_uidx" ON "customers" USING btree ("company_id") WHERE "customers"."is_walk_in";--> statement-breakpoint
CREATE UNIQUE INDEX "order_tenders_counter_method_uidx" ON "order_tenders" USING btree ("order_id","reference") WHERE "order_tenders"."kind" = 'payment_method';--> statement-breakpoint
CREATE INDEX "orders_shift_idx" ON "orders" USING btree ("shift_id") WHERE "orders"."shift_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_key_uidx" ON "orders" USING btree ("idempotency_key") WHERE "orders"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_z_number_uidx" ON "shifts" USING btree ("company_id","z_number") WHERE "shifts"."z_number" IS NOT NULL;
--> statement-breakpoint
-- A sale is rung up only into a shift that is open, and its tenders only added while that shift is still open: a closed shift, and the Z report made from it, never change.
CREATE FUNCTION orders_shift_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.shift_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.shift_id IS DISTINCT FROM OLD.shift_id) THEN
    IF (SELECT status FROM shifts WHERE id = NEW.shift_id) IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'A sale can only be rung up in a shift that is open' USING ERRCODE = '23001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER orders_shift_guard_trg BEFORE INSERT OR UPDATE OF shift_id ON orders FOR EACH ROW EXECUTE FUNCTION orders_shift_guard();
--> statement-breakpoint
CREATE FUNCTION order_tenders_shift_guard() RETURNS trigger AS $$
DECLARE
  shift uuid;
BEGIN
  IF NEW.kind = 'payment_method' THEN
    SELECT shift_id INTO shift FROM orders WHERE id = NEW.order_id;
    IF shift IS NOT NULL AND (SELECT status FROM shifts WHERE id = shift) IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'Cash cannot be added to a shift that is not open' USING ERRCODE = '23001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER order_tenders_shift_guard_trg BEFORE INSERT ON order_tenders FOR EACH ROW EXECUTE FUNCTION order_tenders_shift_guard();
