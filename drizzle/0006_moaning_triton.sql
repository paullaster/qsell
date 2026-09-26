ALTER TABLE "products" ALTER COLUMN "specifications" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "additional_images" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "tags" SET DEFAULT '[]'::jsonb;