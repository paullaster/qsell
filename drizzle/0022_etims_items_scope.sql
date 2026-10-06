DROP INDEX "etims_items_product_branch_uidx";--> statement-breakpoint
DROP INDEX "etims_items_branch_code_uidx";--> statement-breakpoint
ALTER TABLE "etims_items" ALTER COLUMN "branch_id" DROP NOT NULL;--> statement-breakpoint
-- Items used to be keyed by branch only. A row registered through a branch that does not act
-- independently has no valid place in the company/branch split; refuse to guess where it goes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "etims_items" WHERE "config_source" = 'company') THEN
    RAISE EXCEPTION 'etims_items has rows registered via a non-independent branch; re-home or delete them before migrating';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "etims_items" ADD COLUMN "company_id" uuid;--> statement-breakpoint
UPDATE "etims_items" e SET "company_id" = b."company_id" FROM "branches" b WHERE b."id" = e."branch_id";--> statement-breakpoint
ALTER TABLE "etims_items" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "etims_items" ADD CONSTRAINT "etims_items_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "etims_items_company_product_uidx" ON "etims_items" USING btree ("company_id","product_id") WHERE "etims_items"."config_source" = 'company' and "etims_items"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "etims_items_branch_product_uidx" ON "etims_items" USING btree ("branch_id","product_id") WHERE "etims_items"."config_source" = 'branch' and "etims_items"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "etims_items_company_code_uidx" ON "etims_items" USING btree ("company_id","kra_item_code") WHERE "etims_items"."config_source" = 'company' and "etims_items"."kra_item_code" is not null and "etims_items"."status" <> 'deleted';--> statement-breakpoint
CREATE UNIQUE INDEX "etims_items_branch_code_uidx" ON "etims_items" USING btree ("branch_id","kra_item_code") WHERE "etims_items"."config_source" = 'branch' and "etims_items"."kra_item_code" is not null and "etims_items"."status" <> 'deleted';--> statement-breakpoint
ALTER TABLE "etims_items" ADD CONSTRAINT "etims_items_scope_branch_chk" CHECK (("etims_items"."config_source" = 'company' and "etims_items"."branch_id" is null) or ("etims_items"."config_source" = 'branch' and "etims_items"."branch_id" is not null));