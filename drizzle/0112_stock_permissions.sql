-- Stock by location has its own permissions. Nobody who could use the stock screens loses anything: whoever could read the stock ledger
-- can read stock by location, and whoever could receive, write off and audit stock can run locations, transfers and counts.
INSERT INTO "permissions" ("key", "resource", "action", "category", "description") VALUES
  ('stock:read', 'stock', 'read', 'Products & Inventory', 'See stock by location, and the transfers and counts of stock between and within them'),
  ('stock:locations_manage', 'stock', 'locations_manage', 'Products & Inventory', 'Add, change, stop and restart the places stock is held (warehouses, shops, vans)'),
  ('stock:transfer_request', 'stock', 'transfer_request', 'Products & Inventory', 'Ask for stock to be moved from one location to another, and change or cancel such a request'),
  ('stock:transfer_approve', 'stock', 'transfer_approve', 'Products & Inventory', 'Approve a stock transfer that someone else asked for'),
  ('stock:transfer_ship', 'stock', 'transfer_ship', 'Products & Inventory', 'Send a stock transfer from its location, and settle stock that did not arrive'),
  ('stock:transfer_receive', 'stock', 'transfer_receive', 'Products & Inventory', 'Record what arrived of a stock transfer'),
  ('stock:count', 'stock', 'count', 'Products & Inventory', 'Open a stock count, enter counted quantities and hand the count in'),
  ('stock:count_approve', 'stock', 'count_approve', 'Products & Inventory', 'Approve and post a stock count, which changes the stock to what was counted')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT rp."role_id", np."id", rp."effect"
FROM "role_permissions" rp
JOIN "permissions" op ON op."id" = rp."permission_id" AND op."key" = 'inventory:read'
JOIN "permissions" np ON np."key" = 'stock:read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT rp."role_id", np."id", rp."effect"
FROM "role_permissions" rp
JOIN "permissions" op ON op."id" = rp."permission_id" AND op."key" = 'inventory:adjust'
JOIN "permissions" np ON np."key" IN ('stock:locations_manage', 'stock:transfer_request', 'stock:transfer_approve', 'stock:transfer_ship', 'stock:transfer_receive', 'stock:count', 'stock:count_approve')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "user_permissions" ("user_id", "permission_id", "effect", "branch_id", "assigned_by", "expires_at")
SELECT up."user_id", np."id", up."effect", up."branch_id", up."assigned_by", up."expires_at"
FROM "user_permissions" up
JOIN "permissions" op ON op."id" = up."permission_id" AND op."key" = 'inventory:read'
JOIN "permissions" np ON np."key" = 'stock:read'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "user_permissions" ("user_id", "permission_id", "effect", "branch_id", "assigned_by", "expires_at")
SELECT up."user_id", np."id", up."effect", up."branch_id", up."assigned_by", up."expires_at"
FROM "user_permissions" up
JOIN "permissions" op ON op."id" = up."permission_id" AND op."key" = 'inventory:adjust'
JOIN "permissions" np ON np."key" IN ('stock:locations_manage', 'stock:transfer_request', 'stock:transfer_approve', 'stock:transfer_ship', 'stock:transfer_receive', 'stock:count', 'stock:count_approve')
ON CONFLICT DO NOTHING;
