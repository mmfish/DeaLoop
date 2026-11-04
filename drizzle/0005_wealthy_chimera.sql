CREATE TABLE `oauth_refresh_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`replacement_hash` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `oauth_refresh_connection` ON `oauth_refresh_tokens` (`connection_id`);--> statement-breakpoint
ALTER TABLE `connections` ADD `oauth_refresh_expires_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `refresh_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_requests` ADD `renewable` integer DEFAULT 0 NOT NULL;