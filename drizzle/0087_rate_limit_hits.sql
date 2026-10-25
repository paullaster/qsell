CREATE TABLE "rate_limit_hits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_hits_key_window_start_pk" PRIMARY KEY("key","window_start"),
	CONSTRAINT "rate_limit_hits_hits_chk" CHECK ("rate_limit_hits"."hits" >= 0)
);
--> statement-breakpoint
CREATE INDEX "rate_limit_hits_window_idx" ON "rate_limit_hits" USING btree ("window_start");