CREATE TABLE `shortlist_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`actor_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shortlist_idempotency` ON `shortlist_actions` (`owner_id`,`actor_key`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `shortlist_entries` (
	`post_id` text NOT NULL,
	`rank` integer NOT NULL,
	`offer_id` text NOT NULL,
	`offer_revision` integer NOT NULL,
	`summary` text NOT NULL,
	`reason` text NOT NULL,
	`price` integer NOT NULL,
	`condition` text NOT NULL,
	`delivery` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shortlist_rank_bounds" CHECK("shortlist_entries"."rank" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shortlist_rank` ON `shortlist_entries` (`post_id`,`rank`);--> statement-breakpoint
CREATE UNIQUE INDEX `shortlist_offer` ON `shortlist_entries` (`post_id`,`offer_id`);--> statement-breakpoint
CREATE TABLE `shortlist_state` (
	`post_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`actor` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action
);
