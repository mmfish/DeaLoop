ALTER TABLE `connections` ADD `oauth_resource` text;--> statement-breakpoint
ALTER TABLE `oauth_requests` ADD `scope` text DEFAULT 'identity:read' NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_requests` ADD `resource` text;