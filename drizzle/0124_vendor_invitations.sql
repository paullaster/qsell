CREATE TABLE "vendor_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"email" text NOT NULL,
	"invitee_name" text NOT NULL,
	"portal_role" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"delivery_error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_invitations_email_chk" CHECK ("vendor_invitations"."email" = lower(btrim("vendor_invitations"."email"))),
	CONSTRAINT "vendor_invitations_role_chk" CHECK ("vendor_invitations"."portal_role" IN ('owner','finance','sales','readonly')),
	CONSTRAINT "vendor_invitations_status_chk" CHECK ("vendor_invitations"."status" IN ('pending','accepted','revoked','expired')),
	CONSTRAINT "vendor_invitations_delivery_chk" CHECK ("vendor_invitations"."delivery_status" IN ('pending','sent','failed')),
	CONSTRAINT "vendor_invitations_state_chk" CHECK (("vendor_invitations"."status" = 'accepted') = ("vendor_invitations"."accepted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "vendor_invitations" ADD CONSTRAINT "vendor_invitations_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invitations" ADD CONSTRAINT "vendor_invitations_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invitations" ADD CONSTRAINT "vendor_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_invitations_token_uidx" ON "vendor_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_invitations_pending_email_uidx" ON "vendor_invitations" USING btree ("vendor_id",lower("email")) WHERE "vendor_invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "vendor_invitations_company_status_idx" ON "vendor_invitations" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "vendor_invitations_vendor_idx" ON "vendor_invitations" USING btree ("vendor_id","status","created_at");
