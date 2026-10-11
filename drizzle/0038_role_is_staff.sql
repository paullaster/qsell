ALTER TABLE "roles" ADD COLUMN "is_staff" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "roles" SET "is_staff" = true WHERE "key" IN ('super_admin', 'admin', 'manager');
