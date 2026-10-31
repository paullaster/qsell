CREATE TABLE "stock_integrity_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_integrity_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger" text NOT NULL,
	"ok" boolean NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ran_by" text,
	CONSTRAINT "stock_integrity_runs_trigger_chk" CHECK ("stock_integrity_runs"."trigger" IN ('manual','nightly','cutover'))
);
--> statement-breakpoint
ALTER TABLE "stock_integrity_runs" ADD CONSTRAINT "stock_integrity_runs_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_integrity_runs_company_idx" ON "stock_integrity_runs" USING btree ("company_id","ran_at");--> statement-breakpoint
-- Switching a company over to the per-location stock ledger is for administrators only.
INSERT INTO "permissions" ("key", "resource", "action", "category", "description") VALUES
  ('stock:cutover', 'stock', 'cutover', 'Products & Inventory', 'Switch the company to the new per-location stock ledger, check it, and switch back')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT r."id", p."id", 'allow'
FROM "roles" r
JOIN "permissions" p ON p."key" = 'stock:cutover'
WHERE r."key" = 'admin'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
