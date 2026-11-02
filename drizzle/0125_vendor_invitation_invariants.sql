ALTER TABLE "vendor_invitations" DROP CONSTRAINT "vendor_invitations_state_chk";--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_invitations_pending_owner_uidx" ON "vendor_invitations" USING btree ("vendor_id") WHERE "vendor_invitations"."status" = 'pending' AND "vendor_invitations"."portal_role" = 'owner';--> statement-breakpoint
ALTER TABLE "vendor_invitations" ADD CONSTRAINT "vendor_invitations_state_chk" CHECK (("vendor_invitations"."status" = 'accepted') = ("vendor_invitations"."accepted_at" IS NOT NULL) AND ("vendor_invitations"."status" = 'accepted') = ("vendor_invitations"."accepted_by" IS NOT NULL));
--> statement-breakpoint
CREATE FUNCTION vendor_invitation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vendor invitations are retained for audit; revoke pending invitations instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a completed, revoked or expired vendor invitation is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id
    OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.invitee_name IS DISTINCT FROM OLD.invitee_name
    OR NEW.portal_role IS DISTINCT FROM OLD.portal_role
    OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'vendor invitation identity and role are immutable; revoke and issue a new invitation' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> NEW.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('accepted','revoked','expired')) THEN
    RAISE EXCEPTION 'a finished vendor invitation cannot be reopened' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'accepted' AND (NEW.accepted_by IS DISTINCT FROM OLD.accepted_by OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at) THEN
    RAISE EXCEPTION 'a vendor invitation acceptance is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = NEW.accepted_by AND lower(u.email) = NEW.email AND u.role IN ('vendor','customer') AND u.email_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'an invitation can only be accepted by a verified vendor login for its invited email' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1 FROM vendor_users vu
    WHERE vu.vendor_id = NEW.vendor_id AND vu.user_id = NEW.accepted_by AND vu.portal_role = NEW.portal_role AND vu.status = 'active'
  ) THEN
    RAISE EXCEPTION 'create the vendor portal membership before accepting its invitation' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER vendor_invitations_guard BEFORE UPDATE OR DELETE ON vendor_invitations FOR EACH ROW EXECUTE FUNCTION vendor_invitation_guard();
