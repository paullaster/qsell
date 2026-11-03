CREATE TABLE "order_collections" (
	"order_id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"code_sealed" jsonb NOT NULL,
	"code_fingerprint" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"ready_at" timestamp with time zone,
	"ready_by" text,
	"collected_at" timestamp with time zone,
	"collected_by" text,
	"collected_how" text,
	"id_seen" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_collections_status_chk" CHECK ("order_collections"."status" IN ('waiting','ready','collected','locked','cancelled')),
	CONSTRAINT "order_collections_attempts_chk" CHECK ("order_collections"."failed_attempts" >= 0),
	CONSTRAINT "order_collections_how_chk" CHECK ("order_collections"."collected_how" IS NULL OR "order_collections"."collected_how" IN ('code','id_check')),
	CONSTRAINT "order_collections_collected_chk" CHECK (("order_collections"."status" = 'collected') = ("order_collections"."collected_at" IS NOT NULL AND "order_collections"."collected_by" IS NOT NULL AND "order_collections"."collected_how" IS NOT NULL)),
	CONSTRAINT "order_collections_id_chk" CHECK ("order_collections"."collected_how" IS DISTINCT FROM 'id_check' OR ("order_collections"."id_seen" IS NOT NULL AND length("order_collections"."id_seen") >= 4))
);
--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_collections" ADD CONSTRAINT "order_collections_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_collections_branch_status_idx" ON "order_collections" USING btree ("company_id","branch_id","status");