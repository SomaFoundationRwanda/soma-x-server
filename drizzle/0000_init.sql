CREATE TYPE "public"."collection" AS ENUM('curriculum', 'library');--> statement-breakpoint
CREATE TYPE "public"."content_source" AS ENUM('upload', 'watcher', 'scan');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE SEQUENCE "public"."content_change_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "content_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"collection" "collection" NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"description" text,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"mime" text,
	"extension" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"pages" integer,
	"duration_seconds" integer,
	"file_mtime" timestamp with time zone NOT NULL,
	"source" "content_source" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"change_seq" bigint NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_heartbeats" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_at" timestamp with time zone,
	"software_version" text,
	"uptime_seconds" integer,
	"disk_total_bytes" bigint,
	"disk_free_bytes" bigint,
	"mem_total_bytes" bigint,
	"mem_free_bytes" bigint,
	"cpu_load" real,
	"connected_clients" integer,
	"extra" jsonb
);
--> statement-breakpoint
CREATE TABLE "device_inventory" (
	"device_id" uuid NOT NULL,
	"collection" "collection" NOT NULL,
	"path" text NOT NULL,
	"content_item_id" bigint,
	"sha256" text,
	"size" bigint,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_inventory_device_id_collection_path_pk" PRIMARY KEY("device_id","collection","path")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"serial" text,
	"location" text,
	"notes" text,
	"api_key_hash" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"status" "device_status" DEFAULT 'active' NOT NULL,
	"software_version" text,
	"last_seen_at" timestamp with time zone,
	"last_ip" text,
	"last_sync_cursor" bigint,
	"last_sync_at" timestamp with time zone,
	"latest_health" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_serial_unique" UNIQUE("serial"),
	CONSTRAINT "devices_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"client_event_id" text NOT NULL,
	"type" text NOT NULL,
	"content_item_id" bigint,
	"collection" "collection",
	"path" text,
	"learner_ref" text,
	"session_ref" text,
	"duration_seconds" integer,
	"progress" real,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extra" jsonb
);
--> statement-breakpoint
ALTER TABLE "device_heartbeats" ADD CONSTRAINT "device_heartbeats_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_inventory" ADD CONSTRAINT "device_inventory_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_inventory" ADD CONSTRAINT "device_inventory_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_content_item_id_content_items_id_fk" FOREIGN KEY ("content_item_id") REFERENCES "public"."content_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_items_collection_path_uq" ON "content_items" USING btree ("collection","path");--> statement-breakpoint
CREATE INDEX "content_items_change_seq_idx" ON "content_items" USING btree ("change_seq");--> statement-breakpoint
CREATE INDEX "content_items_categories_idx" ON "content_items" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "device_heartbeats_device_received_idx" ON "device_heartbeats" USING btree ("device_id","received_at");--> statement-breakpoint
CREATE INDEX "device_inventory_item_idx" ON "device_inventory" USING btree ("content_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_device_client_uq" ON "usage_events" USING btree ("device_id","client_event_id");--> statement-breakpoint
CREATE INDEX "usage_events_occurred_idx" ON "usage_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_item_idx" ON "usage_events" USING btree ("content_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "usage_events_device_idx" ON "usage_events" USING btree ("device_id","occurred_at");