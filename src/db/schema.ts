import { sql } from 'drizzle-orm';
import {
    bigint,
    bigserial,
    index,
    integer,
    jsonb,
    pgEnum,
    pgSequence,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';

export const COLLECTIONS = ['curriculum', 'library'] as const;
export type Collection = (typeof COLLECTIONS)[number];

export const collectionEnum = pgEnum('collection', COLLECTIONS);
export const contentSourceEnum = pgEnum('content_source', ['upload', 'watcher', 'scan']);
export const deviceStatusEnum = pgEnum('device_status', ['active', 'revoked']);

// Every change to a content row takes the next value, so devices can ask
// "what changed since cursor N" without relying on clocks.
export const contentChangeSeq = pgSequence('content_change_seq', { startWith: 1 });

const timestamps = {
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const contentItems = pgTable(
    'content_items',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        collection: collectionEnum('collection').notNull(),
        // Relative to the collection folder, always with forward slashes.
        path: text('path').notNull(),
        title: text('title').notNull(),
        author: text('author'),
        description: text('description'),
        categories: text('categories').array().notNull().default(sql`'{}'::text[]`),
        mime: text('mime'),
        extension: text('extension').notNull(),
        size: bigint('size', { mode: 'number' }).notNull(),
        sha256: text('sha256').notNull(),
        pages: integer('pages'),
        durationSeconds: integer('duration_seconds'),
        fileMtime: timestamp('file_mtime', { withTimezone: true }).notNull(),
        source: contentSourceEnum('source').notNull(),
        // Bumped when the file bytes change.
        version: integer('version').notNull().default(1),
        // Bumped on any change (file, metadata, delete). Sync cursor.
        changeSeq: bigint('change_seq', { mode: 'number' }).notNull(),
        // Set when an admin edits title/description/etc; rescans then leave those fields alone.
        editedAt: timestamp('edited_at', { withTimezone: true }),
        deletedAt: timestamp('deleted_at', { withTimezone: true }),
        ...timestamps,
    },
    t => [
        uniqueIndex('content_items_collection_path_uq').on(t.collection, t.path),
        index('content_items_change_seq_idx').on(t.changeSeq),
        index('content_items_categories_idx').using('gin', t.categories),
    ],
);

export const devices = pgTable(
    'devices',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        name: text('name').notNull(),
        serial: text('serial').unique(),
        location: text('location'),
        notes: text('notes'),
        // sha256 of the API key; the key itself is shown once at creation.
        apiKeyHash: text('api_key_hash').notNull().unique(),
        apiKeyPrefix: text('api_key_prefix').notNull(),
        status: deviceStatusEnum('status').notNull().default('active'),
        // The box's own id (system_settings.box_id), learned from its first sync.
        boxId: text('box_id'),
        // What the box reports with every sync: hardware identity, school, recent sync runs.
        hardware: jsonb('hardware').$type<Record<string, unknown>>(),
        school: jsonb('school').$type<Record<string, unknown>>(),
        syncHistory: jsonb('sync_history').$type<unknown[]>(),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
        lastIp: text('last_ip'),
        // Last content catalogue sync (GET /api/v1/sync).
        lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
        ...timestamps,
    },
    t => [index('devices_box_id_idx').on(t.boxId)],
);

// One row per call to /api/v1/box-sync: shows when each box was alive and how much it sent.
export const deviceCheckins = pgTable(
    'device_checkins',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        deviceId: uuid('device_id')
            .notNull()
            .references(() => devices.id, { onDelete: 'cascade' }),
        receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
        boxId: text('box_id'),
        records: integer('records').notNull(),
        accepted: integer('accepted').notNull(),
        // Status of the box's most recent sync run, from its history.
        lastRunStatus: text('last_run_status'),
        ip: text('ip'),
    },
    t => [index('device_checkins_device_received_idx').on(t.deviceId, t.receivedAt)],
);

/**
 * Records pushed by boxes from their sync outbox (somabox-lms, migration 0014). Append-only and
 * keyed by the record's own syncId, so a batch sent twice stores nothing twice. The current
 * state of a box entity is its latest record by entity_sync_id.
 */
export const boxRecords = pgTable(
    'box_records',
    {
        syncId: uuid('sync_id').primaryKey(),
        deviceId: uuid('device_id')
            .notNull()
            .references(() => devices.id, { onDelete: 'cascade' }),
        boxId: text('box_id'),
        // Box table name: usage_events, courses, enrollments, quiz_attempts, users, ...
        entity: text('entity').notNull(),
        op: text('op').notNull(),
        entitySyncId: uuid('entity_sync_id'),
        occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
        receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
        data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    },
    t => [
        index('box_records_entity_occurred_idx').on(t.entity, t.occurredAt),
        index('box_records_device_entity_idx').on(t.deviceId, t.entity, t.occurredAt),
        index('box_records_entity_sync_idx').on(t.entity, t.entitySyncId, t.occurredAt),
    ],
);

export type ContentItem = typeof contentItems.$inferSelect;
export type Device = typeof devices.$inferSelect;
