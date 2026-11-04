CREATE TABLE "delivery_attempt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"carried" numeric(14, 3) NOT NULL,
	"accepted" numeric(14, 3) NOT NULL,
	"reason_code" text,
	"note" text,
	CONSTRAINT "delivery_attempt_lines_qty_chk" CHECK ("delivery_attempt_lines"."accepted" >= 0 AND "delivery_attempt_lines"."accepted" <= "delivery_attempt_lines"."carried"),
	CONSTRAINT "delivery_attempt_lines_reason_chk" CHECK (("delivery_attempt_lines"."accepted" < "delivery_attempt_lines"."carried") = ("delivery_attempt_lines"."reason_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "scheduled_for" date;--> statement-breakpoint
ALTER TABLE "delivery_attempt_lines" ADD CONSTRAINT "delivery_attempt_lines_attempt_id_delivery_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."delivery_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempt_lines" ADD CONSTRAINT "delivery_attempt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempt_lines_uidx" ON "delivery_attempt_lines" USING btree ("attempt_id","product_id");--> statement-breakpoint
-- What the customer took at a door is kept like the attempt it belongs to.
CREATE TRIGGER delivery_attempt_lines_no_change BEFORE UPDATE OR DELETE ON "delivery_attempt_lines" FOR EACH ROW EXECUTE FUNCTION delivery_attempts_guard();
