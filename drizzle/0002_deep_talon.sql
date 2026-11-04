CREATE TABLE `deals` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`offer_id` text NOT NULL,
	`revision` integer NOT NULL,
	`buyer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`terms_json` text NOT NULL,
	`accepted_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deals_post_id_unique` ON `deals` (`post_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deals_offer_id_unique` ON `deals` (`offer_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`offer_id` text NOT NULL,
	`author_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_id_unique` ON `messages` (`id`);--> statement-breakpoint
CREATE INDEX `message_offer` ON `messages` (`offer_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `negotiation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`actor_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`offer_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `negotiation_idempotency` ON `negotiation_actions` (`owner_id`,`actor_key`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `negotiation_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`offer_id` text NOT NULL,
	`post_id` text NOT NULL,
	`revision` integer NOT NULL,
	`actor_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `negotiation_inbox` ON `negotiation_events` (`owner_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `offer_revisions` (
	`offer_id` text NOT NULL,
	`revision` integer NOT NULL,
	`author_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`terms_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`offer_id`) REFERENCES `offers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offer_revision` ON `offer_revisions` (`offer_id`,`revision`);--> statement-breakpoint
CREATE TABLE `offers` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`post_owner_id` text NOT NULL,
	`offerer_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`price` integer NOT NULL,
	`item` text NOT NULL,
	`condition` text NOT NULL,
	`delivery` text NOT NULL,
	`terms` text NOT NULL,
	`expires_at` integer NOT NULL,
	`proposed_by` text NOT NULL,
	`confirmed_revision` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`post_owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`offerer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `offer_post` ON `offers` (`post_id`,`status`);--> statement-breakpoint
CREATE INDEX `offer_owner` ON `offers` (`post_owner_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `offer_responder` ON `offers` (`offerer_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `connections` ADD `can_negotiate` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `can_accept` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `min_deal_price` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `max_deal_price` integer DEFAULT 0 NOT NULL;