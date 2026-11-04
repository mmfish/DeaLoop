CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`state` text NOT NULL,
	`challenge` text NOT NULL,
	`owner_id` text NOT NULL,
	`csrf_hash` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`code_hash` text,
	`code_expires_at` integer,
	`connection_id` text,
	`issued_token_hash` text,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_requests_code_hash_unique` ON `oauth_requests` (`code_hash`);--> statement-breakpoint
CREATE INDEX `oauth_request_expiry` ON `oauth_requests` (`expires_at`);--> statement-breakpoint
ALTER TABLE `connections` ADD `oauth_scope` text;