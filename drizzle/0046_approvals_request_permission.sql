-- "approvals:act" used to cover both deciding on other people's documents and following your own
-- requests. The second half is now "approvals:request". Anyone who could use the old permission
-- keeps access to both screens: copy every existing grant (role and per-user, allow and deny).
INSERT INTO "permissions" ("key", "resource", "action", "category", "description") VALUES
  ('approvals:request', 'approvals', 'request', 'Orders & Sales', 'Follow the documents you sent for approval, and withdraw or reopen them ("My requests")')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT rp."role_id", np."id", rp."effect"
FROM "role_permissions" rp
JOIN "permissions" op ON op."id" = rp."permission_id" AND op."key" = 'approvals:act'
JOIN "permissions" np ON np."key" = 'approvals:request'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "user_permissions" ("user_id", "permission_id", "effect", "branch_id", "assigned_by", "expires_at")
SELECT up."user_id", np."id", up."effect", up."branch_id", up."assigned_by", up."expires_at"
FROM "user_permissions" up
JOIN "permissions" op ON op."id" = up."permission_id" AND op."key" = 'approvals:act'
JOIN "permissions" np ON np."key" = 'approvals:request'
ON CONFLICT DO NOTHING;
