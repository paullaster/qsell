CREATE TABLE "order_deliveries" (
	"order_id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"method" text NOT NULL,
	"branch_id" uuid,
	"destination" jsonb NOT NULL,
	"choice" jsonb NOT NULL,
	"charge" jsonb NOT NULL,
	"charge_amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_deliveries_amount_chk" CHECK ("order_deliveries"."charge_amount" >= 0),
	CONSTRAINT "order_deliveries_method_chk" CHECK ("order_deliveries"."method" IN ('own_fleet','courier','pickup','scheduled_visit'))
);
--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD CONSTRAINT "order_deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD CONSTRAINT "order_deliveries_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD CONSTRAINT "order_deliveries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_deliveries_company_branch_idx" ON "order_deliveries" USING btree ("company_id","branch_id");--> statement-breakpoint
-- What an order was told about its delivery is a record, not a setting: the branch, the reason, the place and the charge with its working
-- cannot be edited afterwards (a branch that is later removed only loses its link). A changed delivery is a new quote on the order.
CREATE FUNCTION order_deliveries_frozen() RETURNS trigger AS $$
BEGIN
	IF NEW.order_id IS DISTINCT FROM OLD.order_id
		OR NEW.company_id IS DISTINCT FROM OLD.company_id
		OR NEW.method IS DISTINCT FROM OLD.method
		OR NEW.destination IS DISTINCT FROM OLD.destination
		OR NEW.choice IS DISTINCT FROM OLD.choice
		OR NEW.charge IS DISTINCT FROM OLD.charge
		OR NEW.charge_amount IS DISTINCT FROM OLD.charge_amount
		OR NEW.currency IS DISTINCT FROM OLD.currency
		OR (NEW.branch_id IS DISTINCT FROM OLD.branch_id AND NEW.branch_id IS NOT NULL) THEN
		RAISE EXCEPTION 'The delivery recorded on an order cannot be changed';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER order_deliveries_frozen_trg BEFORE UPDATE ON order_deliveries FOR EACH ROW EXECUTE FUNCTION order_deliveries_frozen();
