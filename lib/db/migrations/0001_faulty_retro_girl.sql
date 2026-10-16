CREATE TABLE "trade_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"trade_id" text NOT NULL,
	"symbol" text NOT NULL,
	"event_type" text NOT NULL,
	"source" text NOT NULL,
	"price" numeric(20, 8),
	"roi_pct" numeric(10, 4),
	"payload" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "trade_id" text;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "opened_by" text;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "data_confidence" text DEFAULT 'full';--> statement-breakpoint
ALTER TABLE "position_entry_log" ADD COLUMN "trade_id" text;