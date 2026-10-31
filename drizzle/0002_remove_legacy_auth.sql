-- Discard sessions from the initial prototype. Existing users are preserved.
DROP TABLE IF EXISTS cns_sessions;
--> statement-breakpoint
DROP TABLE IF EXISTS cns_identities;
--> statement-breakpoint
DROP TABLE IF EXISTS oauth_attempts;
