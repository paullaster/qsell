CREATE TABLE "order_visit_crew" (
	"visit_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_visit_crew_visit_id_user_id_pk" PRIMARY KEY("visit_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "order_visit_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" text,
	CONSTRAINT "order_visit_items_done_chk" CHECK ("order_visit_items"."done" = ("order_visit_items"."done_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "order_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"address" text NOT NULL,
	"contact_name" text,
	"contact_phone" text,
	"notes" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"signed_off_at" timestamp with time zone,
	"signed_off_by" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_visits_status_chk" CHECK ("order_visits"."status" IN ('scheduled','crew_assigned','on_site','completed','signed_off','cancelled')),
	CONSTRAINT "order_visits_window_chk" CHECK ("order_visits"."ends_at" > "order_visits"."starts_at"),
	CONSTRAINT "order_visits_signoff_chk" CHECK (("order_visits"."status" = 'signed_off') = ("order_visits"."signed_off_at" IS NOT NULL AND "order_visits"."signed_off_by" IS NOT NULL)),
	CONSTRAINT "order_visits_cancel_chk" CHECK (("order_visits"."status" = 'cancelled') = ("order_visits"."cancelled_at" IS NOT NULL AND "order_visits"."cancel_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "order_visit_crew" ADD CONSTRAINT "order_visit_crew_visit_id_order_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."order_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_visit_crew" ADD CONSTRAINT "order_visit_crew_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_visit_items" ADD CONSTRAINT "order_visit_items_visit_id_order_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."order_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_visits" ADD CONSTRAINT "order_visits_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_visits" ADD CONSTRAINT "order_visits_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_visit_crew_user_idx" ON "order_visit_crew" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_visit_items_position_idx" ON "order_visit_items" USING btree ("visit_id","position");--> statement-breakpoint
CREATE INDEX "order_visits_company_start_idx" ON "order_visits" USING btree ("company_id","starts_at","id");--> statement-breakpoint
CREATE INDEX "order_visits_company_status_idx" ON "order_visits" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_visits_one_live_per_order_idx" ON "order_visits" USING btree ("order_id") WHERE "order_visits"."status" <> 'cancelled';--> statement-breakpoint
-- A visit is cancelled, never deleted: what was agreed with the customer and what happened stay on record.
CREATE FUNCTION order_visits_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A visit cannot be deleted; cancel it with a reason instead.';
END;
$$;--> statement-breakpoint
CREATE TRIGGER order_visits_no_delete BEFORE DELETE ON "order_visits" FOR EACH ROW EXECUTE FUNCTION order_visits_no_delete();
