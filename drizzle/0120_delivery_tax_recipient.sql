ALTER TABLE "charge_policies" ADD COLUMN "tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "charge_policies" ADD COLUMN "tax_inclusive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD COLUMN "charge_net" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD COLUMN "charge_tax" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD COLUMN "tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD COLUMN "recipient_phone" text;--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "charge_policies" ADD CONSTRAINT "charge_policies_tax_chk" CHECK ("charge_policies"."tax_rate" >= 0 AND "charge_policies"."tax_rate" <= 100);--> statement-breakpoint
-- Deliveries recorded before tax was kept had none: what was charged was the charge before tax.
UPDATE "order_deliveries" SET "charge_net" = "charge_amount" WHERE "charge_net" = 0 AND "charge_amount" <> 0;
--> statement-breakpoint
ALTER TABLE "order_deliveries" ADD CONSTRAINT "order_deliveries_split_chk" CHECK ("order_deliveries"."charge_net" >= 0 AND "order_deliveries"."charge_tax" >= 0 AND "order_deliveries"."charge_net" + "order_deliveries"."charge_tax" = "order_deliveries"."charge_amount" AND "order_deliveries"."tax_rate" >= 0 AND "order_deliveries"."tax_rate" <= 100);
--> statement-breakpoint
-- The parts of the charge are as frozen as the charge.
CREATE OR REPLACE FUNCTION order_deliveries_frozen() RETURNS trigger AS $$
BEGIN
	IF NEW.order_id IS DISTINCT FROM OLD.order_id
		OR NEW.company_id IS DISTINCT FROM OLD.company_id
		OR NEW.method IS DISTINCT FROM OLD.method
		OR NEW.destination IS DISTINCT FROM OLD.destination
		OR NEW.choice IS DISTINCT FROM OLD.choice
		OR NEW.charge IS DISTINCT FROM OLD.charge
		OR NEW.charge_amount IS DISTINCT FROM OLD.charge_amount
		OR NEW.charge_net IS DISTINCT FROM OLD.charge_net
		OR NEW.charge_tax IS DISTINCT FROM OLD.charge_tax
		OR NEW.tax_rate IS DISTINCT FROM OLD.tax_rate
		OR NEW.currency IS DISTINCT FROM OLD.currency
		OR (NEW.branch_id IS DISTINCT FROM OLD.branch_id AND NEW.branch_id IS NOT NULL) THEN
		RAISE EXCEPTION 'The delivery recorded on an order cannot be changed';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
