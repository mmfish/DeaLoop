CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`post_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_owner` ON `activities` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`device_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`name` text NOT NULL,
	`owner_id` text,
	`status` text NOT NULL,
	`token_hash` text,
	`can_write` integer DEFAULT 0 NOT NULL,
	`max_posts` integer DEFAULT 10 NOT NULL,
	`max_price` integer DEFAULT 50000 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_device_hash_unique` ON `connections` (`device_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `connections_user_code_unique` ON `connections` (`user_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `connections_token_hash_unique` ON `connections` (`token_hash`);--> statement-breakpoint
CREATE INDEX `connection_owner` ON `connections` (`owner_id`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`content_type` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`actor` text NOT NULL,
	`agent_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`category` text NOT NULL,
	`price` integer NOT NULL,
	`condition` text NOT NULL,
	`location` text NOT NULL,
	`delivery` text NOT NULL,
	`image` text,
	`status` text DEFAULT 'active' NOT NULL,
	`demo` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_idempotency` ON `posts` (`owner_id`,`actor`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `post_browse` ON `posts` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `post_owner` ON `posts` (`owner_id`);--> statement-breakpoint
CREATE INDEX `post_agent` ON `posts` (`agent_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
