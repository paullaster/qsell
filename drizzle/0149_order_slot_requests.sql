CREATE TABLE "order_slot_requests" (
	"order_id" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"day" date NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"delivery_id" uuid,
	"outcome_note" text,
	"settled_at" timestamp with time zone,
	CONSTRAINT "order_slot_requests_outcome_chk" CHECK ("order_slot_requests"."outcome" IN ('pending','booked','unavailable'))
);
--> statement-breakpoint
ALTER TABLE "order_slot_requests" ADD CONSTRAINT "order_slot_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_slot_requests" ADD CONSTRAINT "order_slot_requests_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_slot_requests" ADD CONSTRAINT "order_slot_requests_slot_id_delivery_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."delivery_slots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_slot_requests" ADD CONSTRAINT "order_slot_requests_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_slot_requests_slot_idx" ON "order_slot_requests" USING btree ("slot_id","day");