CREATE TABLE "registers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shift_movements_kind_chk" CHECK ("shift_movements"."kind" IN ('paid_in', 'paid_out')),
	CONSTRAINT "shift_movements_amount_chk" CHECK ("shift_movements"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "shift_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"tolerance_amount" numeric(14, 2) DEFAULT '100' NOT NULL,
	"tolerance_percent" numeric(7, 3) DEFAULT '1' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_float" numeric(14, 2) NOT NULL,
	"opening_counted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	"declared_cash" numeric(14, 2),
	"closing_counted" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_cash" numeric(14, 2),
	"variance" numeric(14, 2),
	"variance_reason" text,
	"closing_figures" jsonb,
	"z_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shifts_status_chk" CHECK ("shifts"."status" IN ('open', 'closed')),
	CONSTRAINT "shifts_closed_chk" CHECK (("shifts"."status" = 'open' AND "shifts"."closed_at" IS NULL) OR ("shifts"."status" = 'closed' AND "shifts"."closed_at" IS NOT NULL AND "shifts"."declared_cash" IS NOT NULL AND "shifts"."z_number" IS NOT NULL)),
	CONSTRAINT "shifts_float_chk" CHECK ("shifts"."opening_float" >= 0)
);
--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_movements" ADD CONSTRAINT "shift_movements_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_settings" ADD CONSTRAINT "shift_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_register_id_registers_id_fk" FOREIGN KEY ("register_id") REFERENCES "public"."registers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registers_branch_name_uidx" ON "registers" USING btree ("company_id","branch_id","name");--> statement-breakpoint
CREATE INDEX "shift_movements_shift_idx" ON "shift_movements" USING btree ("shift_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_open_per_register_uidx" ON "shifts" USING btree ("register_id") WHERE "shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_one_open_per_person_uidx" ON "shifts" USING btree ("opened_by") WHERE "shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "shifts_z_number_uidx" ON "shifts" USING btree ("z_number") WHERE "shifts"."z_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shifts_company_opened_idx" ON "shifts" USING btree ("company_id","opened_at");--> statement-breakpoint
CREATE FUNCTION shifts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a shift cannot be deleted' USING ERRCODE = '23001';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'a closed shift cannot be changed' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER shifts_guard_trg BEFORE UPDATE OR DELETE ON shifts FOR EACH ROW EXECUTE FUNCTION shifts_guard();
--> statement-breakpoint
CREATE FUNCTION shift_movements_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT status FROM shifts WHERE id = NEW.shift_id) <> 'open' THEN
      RAISE EXCEPTION 'cash cannot be put in or taken out of a shift that is closed' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a movement of cash cannot be changed or removed' USING ERRCODE = '23001';
END $$;
--> statement-breakpoint
CREATE TRIGGER shift_movements_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON shift_movements FOR EACH ROW EXECUTE FUNCTION shift_movements_guard();
