CREATE TABLE "shop_carts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminded_at" timestamp with time zone,
	"reminders_off" boolean DEFAULT false NOT NULL,
	"optout_token" text NOT NULL,
	CONSTRAINT "shop_carts_lines_chk" CHECK (jsonb_typeof("shop_carts"."lines") = 'array' AND jsonb_array_length("shop_carts"."lines") <= 100)
);
--> statement-breakpoint
ALTER TABLE "shop_carts" ADD CONSTRAINT "shop_carts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_carts_optout_token_uidx" ON "shop_carts" USING btree ("optout_token");--> statement-breakpoint
CREATE INDEX "shop_carts_sweep_idx" ON "shop_carts" USING btree ("updated_at") WHERE "shop_carts"."reminders_off" = false AND "shop_carts"."lines" <> '[]'::jsonb;