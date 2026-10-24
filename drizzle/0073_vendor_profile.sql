CREATE TABLE "vendor_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"bank_name" text NOT NULL,
	"branch" text NOT NULL,
	"account_name" text NOT NULL,
	"account_sealed" jsonb NOT NULL,
	"account_last4" text NOT NULL,
	"account_hash" text NOT NULL,
	"swift" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_bank_status_chk" CHECK ("vendor_bank_accounts"."status" IN ('draft','active','pending_change','retired'))
);
--> statement-breakpoint
CREATE TABLE "vendor_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"email" text NOT NULL,
	"phone" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_contacts_role_chk" CHECK ("vendor_contacts"."role" IN ('management','sales','finance','technical'))
);
--> statement-breakpoint
CREATE TABLE "vendor_directors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"id_type" text NOT NULL,
	"id_number_sealed" jsonb NOT NULL,
	"id_last4" text NOT NULL,
	"share_percent" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_directors_share_chk" CHECK ("vendor_directors"."share_percent" IS NULL OR "vendor_directors"."share_percent" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "vendor_document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"required_for_all" boolean DEFAULT false NOT NULL,
	"needs_expiry" boolean DEFAULT false NOT NULL,
	"reminder_days" jsonb DEFAULT '[30,7,0]'::jsonb NOT NULL,
	"blocking" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_document_types_code_chk" CHECK ("vendor_document_types"."code" ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$')
);
--> statement-breakpoint
CREATE TABLE "vendor_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"document_type_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"issued_on" date,
	"expires_on" date,
	"status" text DEFAULT 'submitted' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_documents_status_chk" CHECK ("vendor_documents"."status" IN ('submitted','valid','invalid','expired','replaced'))
);
--> statement-breakpoint
CREATE TABLE "vendor_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_files_mime_chk" CHECK ("vendor_files"."mime" IN ('application/pdf','image/jpeg','image/png','image/webp')),
	CONSTRAINT "vendor_files_size_chk" CHECK ("vendor_files"."size_bytes" BETWEEN 1 AND 26214400)
);
--> statement-breakpoint
CREATE TABLE "vendor_profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by" text,
	"decision" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"reason_code" text,
	"comment" text,
	"section_notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "vendor_profile_versions_decision_chk" CHECK ("vendor_profile_versions"."decision" IN ('pending','approved','revision_requested','rejected'))
);
--> statement-breakpoint
CREATE TABLE "vendor_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"client_name" text NOT NULL,
	"work_description" text,
	"value_amount" numeric(14, 2),
	"contact_name" text,
	"contact_phone" text,
	"year" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "year_established" integer;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "physical_street" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "physical_city" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "physical_county" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "physical_postal_code" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "postal_address" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "registration_date" date;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "employee_count" integer;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "turnover_band" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "offered_payment_term_days" integer;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "mobile_money_number" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "tax_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "reviewer_id" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_accounts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_directors" ADD CONSTRAINT "vendor_directors_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_document_types" ADD CONSTRAINT "vendor_document_types_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_document_type_id_vendor_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."vendor_document_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_documents" ADD CONSTRAINT "vendor_documents_file_id_vendor_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."vendor_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_files" ADD CONSTRAINT "vendor_files_company_id_company_settings_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company_settings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_files" ADD CONSTRAINT "vendor_files_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_profile_versions" ADD CONSTRAINT "vendor_profile_versions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_references" ADD CONSTRAINT "vendor_references_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_bank_vendor_idx" ON "vendor_bank_accounts" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_bank_hash_idx" ON "vendor_bank_accounts" USING btree ("account_hash");--> statement-breakpoint
CREATE INDEX "vendor_contacts_vendor_idx" ON "vendor_contacts" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_contacts_one_primary_uidx" ON "vendor_contacts" USING btree ("vendor_id") WHERE "vendor_contacts"."is_primary";--> statement-breakpoint
CREATE INDEX "vendor_directors_vendor_idx" ON "vendor_directors" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_document_types_company_code_uidx" ON "vendor_document_types" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "vendor_documents_vendor_idx" ON "vendor_documents" USING btree ("vendor_id","document_type_id");--> statement-breakpoint
CREATE INDEX "vendor_documents_expiry_idx" ON "vendor_documents" USING btree ("expires_on") WHERE "vendor_documents"."status" IN ('submitted','valid');--> statement-breakpoint
CREATE INDEX "vendor_files_vendor_idx" ON "vendor_files" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_profile_versions_uidx" ON "vendor_profile_versions" USING btree ("vendor_id","version");--> statement-breakpoint
CREATE INDEX "vendor_references_vendor_idx" ON "vendor_references" USING btree ("vendor_id");--> statement-breakpoint
-- A file a vendor uploaded is evidence: it can be added, never changed or removed.
CREATE TRIGGER vendor_files_append_only BEFORE UPDATE OR DELETE ON "vendor_files" FOR EACH ROW EXECUTE FUNCTION kernel_forbid_mutation();--> statement-breakpoint
-- A submitted profile is frozen; only the reviewer's decision about it can be written, once.
CREATE FUNCTION vendor_guard_profile_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a submitted vendor profile cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.vendor_id <> OLD.vendor_id OR NEW.version <> OLD.version OR NEW.snapshot <> OLD.snapshot
     OR NEW.submitted_at <> OLD.submitted_at OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by THEN
    RAISE EXCEPTION 'a submitted vendor profile cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.decision <> 'pending' THEN
    RAISE EXCEPTION 'this profile has already been decided' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_profile_versions_guard BEFORE UPDATE OR DELETE ON "vendor_profile_versions" FOR EACH ROW EXECUTE FUNCTION vendor_guard_profile_version();--> statement-breakpoint
-- A bank account's details are never edited: only its status moves (a change is a new row). The sealed number itself may be
-- sealed again under a new master key (the last four digits cannot change; the hash is recomputed then too).
CREATE FUNCTION vendor_guard_bank_account() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a bank account that has been in use cannot be deleted; retire it instead' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.vendor_id <> OLD.vendor_id OR NEW.bank_name <> OLD.bank_name OR NEW.branch <> OLD.branch
     OR NEW.account_name <> OLD.account_name
     OR NEW.account_last4 <> OLD.account_last4 OR NEW.swift IS DISTINCT FROM OLD.swift THEN
    RAISE EXCEPTION 'a vendor bank account cannot be edited; add the new details as a change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER vendor_bank_accounts_guard BEFORE UPDATE OR DELETE ON "vendor_bank_accounts" FOR EACH ROW EXECUTE FUNCTION vendor_guard_bank_account();
