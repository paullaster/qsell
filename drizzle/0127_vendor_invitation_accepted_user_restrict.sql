ALTER TABLE "vendor_invitations" DROP CONSTRAINT "vendor_invitations_accepted_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "vendor_invitations" ADD CONSTRAINT "vendor_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;