-- The shop's search also reads descriptions and tags. A stored, generated vector keeps it in step with the product
-- with no application code, and the GIN index makes a word match as cheap as the name match is. It is left out of
-- schema.ts on purpose: every product read would otherwise carry the vector to the application.
ALTER TABLE "products" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
	to_tsvector('simple', coalesce("description", '') || ' ' || coalesce("tags"::text, ''))
) STORED;--> statement-breakpoint
CREATE INDEX "products_search_vector_idx" ON "products" USING gin ("search_vector");
