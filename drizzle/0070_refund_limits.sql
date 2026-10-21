CREATE TABLE "refund_limits" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"window_hours" integer DEFAULT 24 NOT NULL,
	"max_per_customer" integer,
	"max_amount_per_customer" numeric(14, 2),
	"max_per_destination" integer,
	"max_per_requester" integer,
	"max_amount_per_requester" numeric(14, 2),
	"mode" text DEFAULT 'review' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_limits_window_chk" CHECK ("refund_limits"."window_hours" BETWEEN 1 AND 720),
	CONSTRAINT "refund_limits_counts_chk" CHECK (COALESCE("refund_limits"."max_per_customer", 1) >= 1 AND COALESCE("refund_limits"."max_per_destination", 1) >= 1 AND COALESCE("refund_limits"."max_per_requester", 1) >= 1),
	CONSTRAINT "refund_limits_amounts_chk" CHECK (COALESCE("refund_limits"."max_amount_per_customer", 1) > 0 AND COALESCE("refund_limits"."max_amount_per_requester", 1) > 0)
);
--> statement-breakpoint
ALTER TABLE "refund_requests" ADD COLUMN "held_for_review" text;--> statement-breakpoint
ALTER TABLE "refund_limits" ADD CONSTRAINT "refund_limits_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refund_requests_requester_idx" ON "refund_requests" USING btree ("company_id","requested_by","created_at");