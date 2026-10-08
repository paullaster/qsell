-- Pricing is a sub-module of Sales, so its approval triggers belong to the Sales module and an
-- approval switch for "Pricing" has to follow them. A switch for one pricing trigger just changes
-- module. A switch for the whole Pricing module becomes one switch for each pricing trigger that
-- has none of its own (turning it onto all of Sales would switch off sales approvals that were
-- never meant to be affected).
UPDATE "approval_switches" s SET "module" = 'sales'
WHERE s."module" = 'pricing' AND s."trigger" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "approval_switches" x
    WHERE x."company_id" = s."company_id" AND x."module" = 'sales' AND x."trigger" = s."trigger"
      AND x."branch_id" IS NOT DISTINCT FROM s."branch_id");--> statement-breakpoint
INSERT INTO "approval_switches" ("company_id", "module", "trigger", "branch_id", "enabled", "changed_by", "updated_at")
SELECT s."company_id", 'sales', t.code, s."branch_id", s."enabled", s."changed_by", s."updated_at"
FROM "approval_switches" s
CROSS JOIN (VALUES ('price_list.publish'), ('price_list.live_change'), ('discount_rule.publish'), ('rebate.settle')) AS t(code)
WHERE s."module" = 'pricing' AND s."trigger" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "approval_switches" WHERE "module" = 'pricing';
