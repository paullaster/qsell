ALTER TABLE "credit_note_lines" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD COLUMN "unit_code" text;--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD COLUMN "qty_per_unit" numeric(24, 10);--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD COLUMN "entered_quantity" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ADD COLUMN "unit_code" text;--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ADD COLUMN "qty_per_unit" numeric(24, 10);--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_unit_id_units_of_measure_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_receipt_lines" ADD CONSTRAINT "return_receipt_lines_unit_id_units_of_measure_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units_of_measure"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_lines_unit_idx" ON "credit_note_lines" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "return_receipt_lines_unit_idx" ON "return_receipt_lines" USING btree ("unit_id");