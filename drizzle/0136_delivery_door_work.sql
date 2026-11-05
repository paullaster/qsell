CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"rider_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"result" text NOT NULL,
	"received_by" text,
	"note" text,
	"latitude" double precision,
	"longitude" double precision,
	"client_key" text NOT NULL,
	"client_time" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_attempts_no_chk" CHECK ("delivery_attempts"."attempt_no" >= 1),
	CONSTRAINT "delivery_attempts_place_chk" CHECK (("delivery_attempts"."latitude" IS NULL) = ("delivery_attempts"."longitude" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "delivery_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"media_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_proofs_kind_chk" CHECK ("delivery_proofs"."kind" IN ('code','photo')),
	CONSTRAINT "delivery_proofs_photo_chk" CHECK (("delivery_proofs"."kind" = 'photo') = ("delivery_proofs"."media_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "handover_code" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "code_tries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_rider_settings" ADD COLUMN "proof" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_run_id_delivery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."delivery_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_rider_id_delivery_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."delivery_riders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_attempt_id_delivery_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."delivery_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_client_uidx" ON "delivery_attempts" USING btree ("company_id","client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_no_uidx" ON "delivery_attempts" USING btree ("delivery_id","attempt_no");--> statement-breakpoint
CREATE INDEX "delivery_attempts_rider_idx" ON "delivery_attempts" USING btree ("rider_id","occurred_at");--> statement-breakpoint
CREATE INDEX "delivery_proofs_attempt_idx" ON "delivery_proofs" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_proofs_media_uidx" ON "delivery_proofs" USING btree ("media_id") WHERE "delivery_proofs"."media_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_code_tries_chk" CHECK ("deliveries"."code_tries" >= 0);--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_handover_code_chk" CHECK ("deliveries"."handover_code" IS NULL OR "deliveries"."handover_code" ~ '^[0-9]{6}$');--> statement-breakpoint
ALTER TABLE "delivery_rider_settings" ADD CONSTRAINT "delivery_rider_settings_proof_chk" CHECK ("delivery_rider_settings"."proof" IN ('none','code','photo','code_or_photo'));--> statement-breakpoint
-- What happened at a door is kept: an attempt and its proofs are never changed or removed. (A correction is a new record elsewhere.)
CREATE FUNCTION delivery_attempts_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'delivery attempts and their proofs are kept; they cannot be changed or deleted' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER delivery_attempts_no_change BEFORE UPDATE OR DELETE ON "delivery_attempts" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();--> statement-breakpoint
CREATE TRIGGER delivery_proofs_no_change BEFORE UPDATE OR DELETE ON "delivery_proofs" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
