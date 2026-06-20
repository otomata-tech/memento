CREATE TABLE "mem_agent_chat_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_slug" text NOT NULL,
	"org" text,
	"sub" text,
	"ip_hash" text,
	"question" text NOT NULL,
	"reply" text,
	"hits" integer,
	"searches" integer,
	"steps" integer,
	"tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mem_agent_chat_log_ws" ON "mem_agent_chat_log" USING btree ("workspace_slug","created_at");