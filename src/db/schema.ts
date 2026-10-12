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
    primaryKey,
    real,
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

export const devices = pgTable('devices', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    serial: text('serial').unique(),
    location: text('location'),
    notes: text('notes'),
    // sha256 of the API key; the key itself is shown once at creation.
    apiKeyHash: text('api_key_hash').notNull().unique(),
    apiKeyPrefix: text('api_key_prefix').notNull(),
    status: deviceStatusEnum('status').notNull().default('active'),
    softwareVersion: text('software_version'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastIp: text('last_ip'),
    lastSyncCursor: bigint('last_sync_cursor', { mode: 'number' }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    latestHealth: jsonb('latest_health').$type<Record<string, unknown>>(),
    ...timestamps,
});

export const deviceHeartbeats = pgTable(
    'device_heartbeats',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        deviceId: uuid('device_id')
            .notNull()
            .references(() => devices.id, { onDelete: 'cascade' }),
        receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
        reportedAt: timestamp('reported_at', { withTimezone: true }),
        softwareVersion: text('software_version'),
        uptimeSeconds: integer('uptime_seconds'),
        diskTotalBytes: bigint('disk_total_bytes', { mode: 'number' }),
        diskFreeBytes: bigint('disk_free_bytes', { mode: 'number' }),
        memTotalBytes: bigint('mem_total_bytes', { mode: 'number' }),
        memFreeBytes: bigint('mem_free_bytes', { mode: 'number' }),
        cpuLoad: real('cpu_load'),
        connectedClients: integer('connected_clients'),
        extra: jsonb('extra').$type<Record<string, unknown>>(),
    },
    t => [index('device_heartbeats_device_received_idx').on(t.deviceId, t.receivedAt)],
);

// What content each box currently has installed (replaced wholesale on each report).
export const deviceInventory = pgTable(
    'device_inventory',
    {
        deviceId: uuid('device_id')
            .notNull()
            .references(() => devices.id, { onDelete: 'cascade' }),
        collection: collectionEnum('collection').notNull(),
        path: text('path').notNull(),
        contentItemId: bigint('content_item_id', { mode: 'number' }).references(() => contentItems.id, {
            onDelete: 'set null',
        }),
        sha256: text('sha256'),
        size: bigint('size', { mode: 'number' }),
        reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
    },
    t => [
        primaryKey({ columns: [t.deviceId, t.collection, t.path] }),
        index('device_inventory_item_idx').on(t.contentItemId),
    ],
);

export const usageEvents = pgTable(
    'usage_events',
    {
        id: bigserial('id', { mode: 'number' }).primaryKey(),
        deviceId: uuid('device_id')
            .notNull()
            .references(() => devices.id, { onDelete: 'cascade' }),
        // Generated on the device; makes retries idempotent.
        clientEventId: text('client_event_id').notNull(),
        type: text('type').notNull(),
        contentItemId: bigint('content_item_id', { mode: 'number' }).references(() => contentItems.id, {
            onDelete: 'set null',
        }),
        collection: collectionEnum('collection'),
        path: text('path'),
        // Anonymous learner/session reference from the device, if any.
        learnerRef: text('learner_ref'),
        sessionRef: text('session_ref'),
        durationSeconds: integer('duration_seconds'),
        progress: real('progress'),
        occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
        receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
        extra: jsonb('extra').$type<Record<string, unknown>>(),
    },
    t => [
        uniqueIndex('usage_events_device_client_uq').on(t.deviceId, t.clientEventId),
        index('usage_events_occurred_idx').on(t.occurredAt),
        index('usage_events_item_idx').on(t.contentItemId, t.occurredAt),
        index('usage_events_device_idx').on(t.deviceId, t.occurredAt),
    ],
);

export type ContentItem = typeof contentItems.$inferSelect;
export type Device = typeof devices.$inferSelect;
