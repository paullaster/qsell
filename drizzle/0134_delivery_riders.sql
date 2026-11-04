CREATE TABLE "delivery_rider_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"allow_staff" boolean DEFAULT true NOT NULL,
	"allow_separate" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_rider_settings_one_chk" CHECK ("delivery_rider_settings"."allow_staff" OR "delivery_rider_settings"."allow_separate")
);
--> statement-breakpoint
CREATE TABLE "delivery_riders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"vehicle" text,
	"branch_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_riders_name_chk" CHECK (btrim("delivery_riders"."name") <> ''),
	CONSTRAINT "delivery_riders_kind_chk" CHECK ("delivery_riders"."kind" IN ('staff','separate')),
	CONSTRAINT "delivery_riders_status_chk" CHECK ("delivery_riders"."status" IN ('active','paused','ended')),
	CONSTRAINT "delivery_riders_reason_chk" CHECK (("delivery_riders"."status" = 'active') OR ("delivery_riders"."status_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD COLUMN "rider_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_rider_settings" ADD CONSTRAINT "delivery_rider_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_riders" ADD CONSTRAINT "delivery_riders_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_riders" ADD CONSTRAINT "delivery_riders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_riders" ADD CONSTRAINT "delivery_riders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_riders_company_user_uidx" ON "delivery_riders" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "delivery_riders_status_idx" ON "delivery_riders" USING btree ("company_id","status","kind");--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_rider_id_delivery_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."delivery_riders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_runs_rider_idx" ON "delivery_runs" USING btree ("rider_id","run_date") WHERE "delivery_runs"."rider_id" IS NOT NULL;