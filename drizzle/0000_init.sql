CREATE TYPE "public"."collection" AS ENUM('curriculum', 'library');--> statement-breakpoint
CREATE TYPE "public"."content_source" AS ENUM('upload', 'watcher', 'scan');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE SEQUENCE "public"."content_change_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "box_records" (
	"sync_id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"box_id" text,
	"entity" text NOT NULL,
	"op" text NOT NULL,
	"entity_sync_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "device_checkins" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"box_id" text,
	"records" integer NOT NULL,
	"accepted" integer NOT NULL,
	"last_run_status" text,
	"ip" text
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
	"box_id" text,
	"hardware" jsonb,
	"school" jsonb,
	"sync_history" jsonb,
	"last_seen_at" timestamp with time zone,
	"last_ip" text,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_serial_unique" UNIQUE("serial"),
	CONSTRAINT "devices_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
ALTER TABLE "box_records" ADD CONSTRAINT "box_records_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_checkins" ADD CONSTRAINT "device_checkins_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_records_entity_occurred_idx" ON "box_records" USING btree ("entity","occurred_at");--> statement-breakpoint
CREATE INDEX "box_records_device_entity_idx" ON "box_records" USING btree ("device_id","entity","occurred_at");--> statement-breakpoint
CREATE INDEX "box_records_entity_sync_idx" ON "box_records" USING btree ("entity","entity_sync_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_items_collection_path_uq" ON "content_items" USING btree ("collection","path");--> statement-breakpoint
CREATE INDEX "content_items_change_seq_idx" ON "content_items" USING btree ("change_seq");--> statement-breakpoint
CREATE INDEX "content_items_categories_idx" ON "content_items" USING gin ("categories");--> statement-breakpoint
CREATE INDEX "device_checkins_device_received_idx" ON "device_checkins" USING btree ("device_id","received_at");--> statement-breakpoint
CREATE INDEX "devices_box_id_idx" ON "devices" USING btree ("box_id");