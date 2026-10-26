CREATE TABLE "rfq_award_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rfq_id" uuid NOT NULL,
	"allocations" jsonb NOT NULL,
	"justification" text,
	"proposed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rfq_award_proposals" ADD CONSTRAINT "rfq_award_proposals_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rfq_award_proposals_rfq_uq" ON "rfq_award_proposals" USING btree ("rfq_id");