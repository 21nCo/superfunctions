CREATE TABLE "__datafn_join_todos_tags" (
	"from" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"to" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"color" text DEFAULT '#646cff' NOT NULL,
	"created_at" bigint NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todos" (
	"completed" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"priority" numeric DEFAULT 3,
	"text" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "categories_name_idx" ON "categories" USING btree ("name");--> statement-breakpoint
CREATE INDEX "todos_completed_idx" ON "todos" USING btree ("completed");--> statement-breakpoint
CREATE INDEX "todos_created_at_idx" ON "todos" USING btree ("created_at");