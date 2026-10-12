import { Router } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { COLLECTIONS } from '../db/schema.js';
import { idParam } from '../http/errors.js';

/** Read-only reporting endpoints, meant to feed dashboards and presentations. */

const DAY = 24 * 3600 * 1000;
const dateParam = z.union([z.iso.datetime({ offset: true }), z.iso.date()]).transform(v => new Date(v));

const usageQuery = z.object({
    from: dateParam.optional(),
    to: dateParam.optional(),
    groupBy: z.enum(['day', 'week', 'month', 'type', 'content', 'device', 'category']).default('day'),
    type: z.string().max(64).optional(),
    deviceId: z.uuid().optional(),
    collection: z.enum(COLLECTIONS).optional(),
    contentId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
});

function range(from?: Date, to?: Date) {
    const end = to ?? new Date();
    return { from: from ?? new Date(end.getTime() - 30 * DAY), to: end };
}

export function statsRouter(db: Db): Router {
    const router = Router();

    router.get('/overview', async (_req, res) => {
        const [content, deviceCounts, events] = await Promise.all([
            db.execute(sql`
                SELECT collection, count(*)::int AS items, coalesce(sum(size), 0)::bigint AS bytes
                FROM content_items WHERE deleted_at IS NULL GROUP BY collection ORDER BY collection`),
            db.execute(sql`
                SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE status = 'active')::int AS active,
                       count(*) FILTER (WHERE last_seen_at > now() - interval '1 day')::int AS seen_24h,
                       count(*) FILTER (WHERE last_seen_at > now() - interval '7 days')::int AS seen_7d
                FROM devices`),
            db.execute(sql`
                SELECT type, count(*)::int AS events, count(DISTINCT learner_ref)::int AS unique_learners,
                       coalesce(sum(duration_seconds), 0)::bigint AS total_duration_seconds
                FROM usage_events WHERE occurred_at > now() - interval '30 days'
                GROUP BY type ORDER BY events DESC`),
        ]);
        res.json({
            content: content.rows.map(r => ({ ...r, bytes: Number(r.bytes) })),
            devices: deviceCounts.rows[0],
            eventsLast30Days: events.rows.map(r => ({ ...r, total_duration_seconds: Number(r.total_duration_seconds) })),
        });
    });

    /** Usage aggregated by time bucket or dimension, e.g. ?groupBy=content&type=view&from=2026-09-01 */
    router.get('/usage', async (req, res) => {
        const q = usageQuery.parse(req.query);
        const { from, to } = range(q.from, q.to);

        const where: SQL[] = [sql`ue.occurred_at >= ${from}`, sql`ue.occurred_at < ${to}`];
        if (q.type) where.push(sql`ue.type = ${q.type}`);
        if (q.deviceId) where.push(sql`ue.device_id = ${q.deviceId}`);
        if (q.collection) where.push(sql`ue.collection = ${q.collection}`);
        if (q.contentId) where.push(sql`ue.content_item_id = ${q.contentId}`);

        let key: SQL;
        let label: SQL;
        let join = sql``;
        switch (q.groupBy) {
            case 'day':
            case 'week':
            case 'month':
                key = sql`to_char(date_trunc(${q.groupBy}, ue.occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
                label = key;
                break;
            case 'type':
                key = sql`ue.type`;
                label = key;
                break;
            case 'content':
                join = sql`LEFT JOIN content_items ci ON ci.id = ue.content_item_id`;
                key = sql`coalesce(ue.content_item_id::text, ue.collection || ':' || ue.path, 'unknown')`;
                label = sql`coalesce(ci.title, ue.path, 'unknown')`;
                break;
            case 'device':
                join = sql`JOIN devices d ON d.id = ue.device_id`;
                key = sql`ue.device_id::text`;
                label = sql`d.name`;
                break;
            case 'category':
                join = sql`JOIN content_items ci ON ci.id = ue.content_item_id CROSS JOIN LATERAL unnest(ci.categories) AS cat(name)`;
                key = sql`cat.name`;
                label = key;
                break;
        }

        const orderBy = ['day', 'week', 'month'].includes(q.groupBy) ? sql`key ASC` : sql`events DESC`;
        const result = await db.execute(sql`
            SELECT ${key} AS key, ${label} AS label,
                   count(*)::int AS events,
                   count(DISTINCT ue.learner_ref)::int AS unique_learners,
                   count(DISTINCT ue.device_id)::int AS unique_devices,
                   coalesce(sum(ue.duration_seconds), 0)::bigint AS total_duration_seconds
            FROM usage_events ue ${join}
            WHERE ${sql.join(where, sql` AND `)}
            GROUP BY 1, 2
            ORDER BY ${orderBy}
            LIMIT ${q.limit}`);
        res.json({
            from,
            to,
            groupBy: q.groupBy,
            rows: result.rows.map(r => ({ ...r, total_duration_seconds: Number(r.total_duration_seconds) })),
        });
    });

    /** One row per device: health, how much content it has, how stale it is, recent activity. */
    router.get('/devices', async (_req, res) => {
        const result = await db.execute(sql`
            SELECT d.id, d.name, d.serial, d.location, d.status, d.software_version, d.last_seen_at, d.last_sync_at,
                   (d.latest_health -> 'disk' ->> 'freeBytes')::bigint AS disk_free_bytes,
                   (d.latest_health -> 'disk' ->> 'totalBytes')::bigint AS disk_total_bytes,
                   coalesce(inv.items, 0)::int AS installed_items,
                   coalesce(inv.outdated, 0)::int AS outdated_items,
                   coalesce(ev.events, 0)::int AS events_30d,
                   coalesce(ev.learners, 0)::int AS unique_learners_30d
            FROM devices d
            LEFT JOIN (
                SELECT di.device_id, count(*) AS items,
                       count(*) FILTER (WHERE di.sha256 IS NOT NULL AND ci.sha256 IS DISTINCT FROM di.sha256) AS outdated
                FROM device_inventory di LEFT JOIN content_items ci ON ci.id = di.content_item_id
                GROUP BY di.device_id
            ) inv ON inv.device_id = d.id
            LEFT JOIN (
                SELECT device_id, count(*) AS events, count(DISTINCT learner_ref) AS learners
                FROM usage_events WHERE occurred_at > now() - interval '30 days' GROUP BY device_id
            ) ev ON ev.device_id = d.id
            ORDER BY d.last_seen_at DESC NULLS LAST, d.name`);
        res.json(
            result.rows.map(r => ({
                ...r,
                disk_free_bytes: r.disk_free_bytes === null ? null : Number(r.disk_free_bytes),
                disk_total_bytes: r.disk_total_bytes === null ? null : Number(r.disk_total_bytes),
            })),
        );
    });

    /** Reach of one item: how many boxes have it and how it is used. */
    router.get('/content/:id', async (req, res) => {
        const id = idParam.parse(req.params.id);
        const [installed, byType] = await Promise.all([
            db.execute(sql`SELECT count(DISTINCT device_id)::int AS devices FROM device_inventory WHERE content_item_id = ${id}`),
            db.execute(sql`
                SELECT type, count(*)::int AS events, count(DISTINCT learner_ref)::int AS unique_learners,
                       count(DISTINCT device_id)::int AS unique_devices,
                       coalesce(sum(duration_seconds), 0)::bigint AS total_duration_seconds,
                       avg(progress)::real AS avg_progress
                FROM usage_events WHERE content_item_id = ${id} GROUP BY type ORDER BY events DESC`),
        ]);
        res.json({
            contentId: id,
            installedOnDevices: installed.rows[0]?.devices ?? 0,
            usage: byType.rows.map(r => ({ ...r, total_duration_seconds: Number(r.total_duration_seconds) })),
        });
    });

    return router;
}
