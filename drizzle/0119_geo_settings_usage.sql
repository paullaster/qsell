CREATE TABLE "geo_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"driver" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "geo_settings_driver_chk" CHECK ("geo_settings"."driver" IN ('builtin','osm','google','mapbox'))
);
--> statement-breakpoint
CREATE TABLE "geo_usage" (
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"op" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"fallbacks" integer DEFAULT 0 NOT NULL,
	"total_ms" bigint DEFAULT 0 NOT NULL,
	"max_ms" integer DEFAULT 0 NOT NULL,
	"under_500" integer DEFAULT 0 NOT NULL,
	"under_1000" integer DEFAULT 0 NOT NULL,
	"under_2500" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "geo_usage_company_id_provider_op_bucket_pk" PRIMARY KEY("company_id","provider","op","bucket"),
	CONSTRAINT "geo_usage_op_chk" CHECK ("geo_usage"."op" IN ('search','resolve','reverse','distance'))
);
--> statement-breakpoint
ALTER TABLE "geo_settings" ADD CONSTRAINT "geo_settings_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_usage" ADD CONSTRAINT "geo_usage_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_usage_company_bucket_idx" ON "geo_usage" USING btree ("company_id","bucket");