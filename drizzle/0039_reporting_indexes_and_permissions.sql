CREATE INDEX "customer_ledger_open_due_idx" ON "customer_ledger_entries" USING btree ("due_date") WHERE "customer_ledger_entries"."remaining_amount" > 0;--> statement-breakpoint
CREATE INDEX "order_tenders_created_idx" ON "order_tenders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_branch_created_idx" ON "orders" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_payment_attention_idx" ON "orders" USING btree ("branch_id") WHERE "orders"."payment_status" in ('pending_verification', 'discrepancy');--> statement-breakpoint
CREATE INDEX "payment_attempts_settled_idx" ON "payment_attempts" USING btree ("paid_at") WHERE "payment_attempts"."status" = 'successful';--> statement-breakpoint
CREATE INDEX "payment_transactions_settled_idx" ON "payment_transactions" USING btree ("updated_at") WHERE "payment_transactions"."status" = 'successful';
--> statement-breakpoint
-- Report permissions. The app also syncs the catalog on boot; inserting them here lets us grant
-- them to the built-in roles exactly once (the seed never re-grants to roles that already exist).
INSERT INTO "permissions" ("key", "resource", "action", "category", "description") VALUES
  ('report_sales:read', 'report_sales', 'read', 'Reports & Insights', 'See sales value, order counts, trends and best-selling products'),
  ('report_collections:read', 'report_collections', 'read', 'Reports & Insights', 'See money collected, broken down by configured payment method'),
  ('report_profit:read', 'report_profit', 'read', 'Reports & Insights', 'See gross profit and margin (reveals product costs)'),
  ('report_receivables:read', 'report_receivables', 'read', 'Reports & Insights', 'See what customers owe and what is overdue'),
  ('report_inventory:read', 'report_inventory', 'read', 'Reports & Insights', 'See stock health: out of stock, low stock and stock value'),
  ('reports:all_branches', 'reports', 'all_branches', 'Reports & Insights', 'Run reports across every branch instead of only your own branch')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT r."id", p."id", 'allow'
FROM "roles" r
JOIN "permissions" p ON p."key" IN (
  'report_sales:read', 'report_collections:read', 'report_profit:read',
  'report_receivables:read', 'report_inventory:read', 'reports:all_branches'
)
WHERE r."key" = 'admin'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT r."id", p."id", 'allow'
FROM "roles" r
JOIN "permissions" p ON p."key" IN (
  'report_sales:read', 'report_collections:read', 'report_receivables:read', 'report_inventory:read'
)
WHERE r."key" = 'manager'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
