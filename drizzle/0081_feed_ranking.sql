CREATE TABLE "feed_candidates" (
	"request_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"sources" text[] NOT NULL,
	"features" real[] NOT NULL,
	"predictions" real[] NOT NULL,
	"score" real NOT NULL,
	"reason" text NOT NULL,
	"explore" boolean DEFAULT false NOT NULL,
	"propensity" real DEFAULT 1 NOT NULL,
	"served_at" timestamp (3) with time zone,
	"page" smallint,
	CONSTRAINT "feed_candidates_request_id_post_id_pk" PRIMARY KEY("request_id","post_id")
);
--> statement-breakpoint
CREATE TABLE "feed_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"values" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_counters" (
	"day" date NOT NULL,
	"name" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "feed_counters_day_name_pk" PRIMARY KEY("day","name"),
	CONSTRAINT "feed_counters_name_check" CHECK ("feed_counters"."name" ~ '^[a-z_]{1,48}$')
);
--> statement-breakpoint
CREATE TABLE "feed_feature_sets" (
	"version" integer PRIMARY KEY NOT NULL,
	"names" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text NOT NULL,
	"feature_version" integer NOT NULL,
	"heads" jsonb,
	"metrics" jsonb,
	"trained_from" timestamp (3) with time zone,
	"trained_to" timestamp (3) with time zone,
	"error" text,
	"requested_by" uuid,
	"activated_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_models_status_check" CHECK ("feed_models"."status" in ('queued', 'training', 'candidate', 'active', 'retired', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "feed_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"mode" text NOT NULL,
	"surface" text NOT NULL,
	"chain_id" uuid NOT NULL,
	"continuation" boolean DEFAULT false NOT NULL,
	"model_id" uuid,
	"config_id" uuid,
	"feature_version" integer NOT NULL,
	"source_counts" jsonb NOT NULL,
	"candidate_count" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"timings" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_requests_mode_check" CHECK ("feed_requests"."mode" in ('personal', 'public')),
	CONSTRAINT "feed_requests_surface_check" CHECK ("feed_requests"."surface" in ('for_you', 'following')),
	CONSTRAINT "feed_requests_owner_check" CHECK (("feed_requests"."mode" = 'public') = ("feed_requests"."user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "feed_candidates" ADD CONSTRAINT "feed_candidates_request_id_feed_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."feed_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_candidates" ADD CONSTRAINT "feed_candidates_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_config" ADD CONSTRAINT "feed_config_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_models" ADD CONSTRAINT "feed_models_feature_version_feed_feature_sets_version_fk" FOREIGN KEY ("feature_version") REFERENCES "public"."feed_feature_sets"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_models" ADD CONSTRAINT "feed_models_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_requests" ADD CONSTRAINT "feed_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_requests" ADD CONSTRAINT "feed_requests_model_id_feed_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."feed_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_requests" ADD CONSTRAINT "feed_requests_config_id_feed_config_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."feed_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_requests" ADD CONSTRAINT "feed_requests_feature_version_feed_feature_sets_version_fk" FOREIGN KEY ("feature_version") REFERENCES "public"."feed_feature_sets"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_candidates_position_idx" ON "feed_candidates" USING btree ("request_id","position");--> statement-breakpoint
CREATE INDEX "feed_candidates_post_idx" ON "feed_candidates" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "feed_config_created_idx" ON "feed_config" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feed_config_created_by_idx" ON "feed_config" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_models_active_idx" ON "feed_models" USING btree ("status") WHERE "feed_models"."status" = 'active';--> statement-breakpoint
CREATE INDEX "feed_models_requested_by_idx" ON "feed_models" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "feed_requests_user_idx" ON "feed_requests" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feed_requests_mode_idx" ON "feed_requests" USING btree ("mode","surface","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feed_requests_chain_idx" ON "feed_requests" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX "feed_requests_created_idx" ON "feed_requests" USING brin ("created_at");--> statement-breakpoint
CREATE INDEX "feed_requests_model_idx" ON "feed_requests" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "feed_requests_config_idx" ON "feed_requests" USING btree ("config_id");