DROP INDEX "approval_entries_overdue_idx";--> statement-breakpoint
ALTER TABLE "approval_entries" ADD COLUMN "replaces_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_entries" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "approval_entries_overdue_idx" ON "approval_entries" USING btree ("due_at") WHERE "approval_entries"."status" = 'open' and "approval_entries"."escalated_at" is null;