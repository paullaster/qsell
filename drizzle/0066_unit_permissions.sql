-- Role grants are written when a role is first created, so roles that already exist do not know the new unit
-- permissions. Whoever may see products may see units of measure; whoever may change products may manage them.
-- (Someone's own later choice to remove it is not undone: this runs once.)
INSERT INTO "permissions" ("key", "resource", "action", "category", "description") VALUES
  ('units:read', 'units', 'read', 'Products & Inventory', 'View units of measure and where they are used'),
  ('units:manage', 'units', 'manage', 'Products & Inventory', 'Create, change, switch off and delete units of measure')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT rp."role_id", np."id", 'allow'
FROM "role_permissions" rp
JOIN "permissions" op ON op."id" = rp."permission_id" AND op."key" = 'products:read' AND rp."effect" = 'allow'
JOIN "permissions" np ON np."key" = 'units:read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT rp."role_id", np."id", 'allow'
FROM "role_permissions" rp
JOIN "permissions" op ON op."id" = rp."permission_id" AND op."key" = 'products:update' AND rp."effect" = 'allow'
JOIN "permissions" np ON np."key" = 'units:manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
