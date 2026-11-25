CREATE TABLE "van_loads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"day_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"transfer_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_by" text,
	"signed_at" timestamp with time zone,
	"signed_on_behalf" boolean DEFAULT false NOT NULL,
	"sign_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "van_loads_kind_chk" CHECK ("van_loads"."kind" IN ('load','top_up')),
	CONSTRAINT "van_loads_signed_chk" CHECK (("van_loads"."signed_by" IS NULL) = ("van_loads"."signed_at" IS NULL)),
	CONSTRAINT "van_loads_behalf_chk" CHECK (NOT "van_loads"."signed_on_behalf" OR ("van_loads"."sign_reason" IS NOT NULL AND length(btrim("van_loads"."sign_reason")) > 0)),
	CONSTRAINT "van_loads_cancelled_chk" CHECK ((("van_loads"."cancelled_at" IS NULL) = ("van_loads"."cancel_reason" IS NULL)) AND ("van_loads"."cancelled_at" IS NULL OR "van_loads"."signed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "van_loads" ADD CONSTRAINT "van_loads_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_loads" ADD CONSTRAINT "van_loads_day_id_van_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."van_days"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_loads" ADD CONSTRAINT "van_loads_transfer_id_stock_documents_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "van_loads" ADD CONSTRAINT "van_loads_from_location_id_stock_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "van_loads_transfer_uidx" ON "van_loads" USING btree ("transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "van_loads_day_load_uidx" ON "van_loads" USING btree ("day_id") WHERE "van_loads"."kind" = 'load' AND "van_loads"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "van_loads_day_idx" ON "van_loads" USING btree ("day_id","created_at");