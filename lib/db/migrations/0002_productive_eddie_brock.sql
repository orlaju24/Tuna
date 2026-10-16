CREATE TABLE "sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar,
	"first_name" varchar,
	"last_name" varchar,
	"profile_image_url" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "safeguards" ADD COLUMN "trailing_mode" text DEFAULT 'adaptive' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "trigger_floor_used" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "floor_wave_phase" text;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "floor_oracle_score" integer;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "extension_score_at_arm" integer;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "extension_phase_at_close" text;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "enriched_at" timestamp;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "realized_pnl" text;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "entry_fee" text;--> statement-breakpoint
ALTER TABLE "trade_journal" ADD COLUMN "exit_fee" text;--> statement-breakpoint
CREATE INDEX "IDX_session_expire" ON "sessions" USING btree ("expire");