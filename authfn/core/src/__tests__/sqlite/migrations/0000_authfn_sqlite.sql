CREATE TABLE `authfn_api_keys` (
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`last_used_at` integer,
	`metadata` text,
	`name` text,
	`revoked_at` integer,
	`scopes` text,
	`secret_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_authfn_api_keys_secret_hash` ON `authfn_api_keys` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `idx_authfn_api_keys_user_id_created_at` ON `authfn_api_keys` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `authfn_password_credentials` (
	`created_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_authfn_password_credentials_user_id` ON `authfn_password_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `authfn_sessions` (
	`created_at` integer NOT NULL,
	`csrf_hash` text,
	`expires_at` integer NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`last_authenticated_at` integer,
	`metadata` text,
	`methods` text NOT NULL,
	`revoked_at` integer,
	`token_hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `authfn_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_authfn_sessions_expires_at` ON `authfn_sessions` (`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_authfn_sessions_token_hash` ON `authfn_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_authfn_sessions_user_id_created_at` ON `authfn_sessions` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `authfn_users` (
	`created_at` integer NOT NULL,
	`email_verified_at` integer,
	`id` text PRIMARY KEY NOT NULL,
	`metadata` text,
	`primary_email` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_authfn_users_primary_email` ON `authfn_users` (`primary_email`);