CREATE TABLE "cash_sale_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"till_mode" text DEFAULT 'admin' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_sale_settings_mode_chk" CHECK ("cash_sale_settings"."till_mode" IN ('admin','fullscreen'))
);
--> statement-breakpoint
CREATE TABLE "held_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"payload" jsonb NOT NULL,
	"line_count" integer NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "held_sales_status_chk" CHECK ("held_sales"."status" IN ('held','recalled','discarded')),
	CONSTRAINT "held_sales_lines_chk" CHECK ("held_sales"."line_count" BETWEEN 1 AND 200),
	CONSTRAINT "held_sales_label_chk" CHECK (char_length("held_sales"."label") <= 60),
	CONSTRAINT "held_sales_resolved_chk" CHECK (("held_sales"."status" = 'held') = ("held_sales"."resolved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "cash_sale_settings" ADD CONSTRAINT "cash_sale_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "held_sales_shift_idx" ON "held_sales" USING btree ("shift_id","status","created_at");--> statement-breakpoint
-- A held sale is a draft that is recalled or given up once: it never goes back to held, and what was put aside is never edited.
CREATE FUNCTION held_sales_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A held sale is never deleted' USING ERRCODE = '23001';
  END IF;
  IF OLD.status <> 'held' THEN
    RAISE EXCEPTION 'A held sale that was recalled or given up cannot be changed' USING ERRCODE = '23001';
  END IF;
  IF NEW.payload <> OLD.payload OR NEW.shift_id <> OLD.shift_id OR NEW.user_id <> OLD.user_id OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'A held sale cannot be changed after it was put aside' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER held_sales_guard_trg BEFORE UPDATE OR DELETE ON held_sales FOR EACH ROW EXECUTE FUNCTION held_sales_guard();
