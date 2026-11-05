CREATE TABLE "delivery_door_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"rider_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"phone_ending" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_door_prompts_amount_chk" CHECK ("delivery_door_prompts"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "delivery_door_prompts" ADD CONSTRAINT "delivery_door_prompts_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_door_prompts" ADD CONSTRAINT "delivery_door_prompts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_door_prompts" ADD CONSTRAINT "delivery_door_prompts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_door_prompts" ADD CONSTRAINT "delivery_door_prompts_rider_id_delivery_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."delivery_riders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_door_prompts" ADD CONSTRAINT "delivery_door_prompts_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_door_prompts_attempt_uidx" ON "delivery_door_prompts" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "delivery_door_prompts_delivery_idx" ON "delivery_door_prompts" USING btree ("delivery_id","created_at");--> statement-breakpoint
-- Which rider asked for which prompt is kept for good.
CREATE TRIGGER delivery_door_prompts_no_change BEFORE UPDATE OR DELETE ON "delivery_door_prompts" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
