import { Router } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { idParam } from '../http/errors.js';

/**
 * Read-only reporting for dashboards and presentations, built on the records boxes push from
 * their sync outbox (box_records) plus the content catalogue.
 */

const DAY = 24 * 3600 * 1000;
const dateParam = z.union([z.iso.datetime({ offset: true }), z.iso.date()]).transform(v => new Date(v));

/**
 * Current state of one box entity: the latest record per (device, entity_sync_id), deletes
 * excluded. Records are append-only change events, so this is how "how many learners" etc. are
 * counted.
 */
export function currentRecords(entity: string): SQL {
    return sql`(
        SELECT * FROM (
            SELECT DISTINCT ON (r.device_id, coalesce(r.entity_sync_id, r.sync_id)) r.*
            FROM box_records r
            WHERE r.entity = ${entity}
            ORDER BY r.device_id, coalesce(r.entity_sync_id, r.sync_id), r.occurred_at DESC, r.received_at DESC
        ) latest WHERE latest.op <> 'delete'
    )`;
}

// When a usage event happened: the box row's own created_at, falling back to when it was queued.
const eventTime = sql`coalesce((ue.data->>'created_at')::timestamptz, ue.occurred_at)`;

const usageQuery = z.object({
    from: dateParam.optional(),
    to: dateParam.optional(),
    groupBy: z
        .enum(['day', 'week', 'month', 'type', 'role', 'device', 'school', 'district', 'course', 'content'])
        .default('day'),
    type: z.string().max(64).optional(),
    deviceId: z.uuid().optional(),
    district: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
});

function range(from?: Date, to?: Date) {
    const end = to ?? new Date();
    return { from: from ?? new Date(end.getTime() - 30 * DAY), to: end };
}

export function statsRouter(db: Db): Router {
    const router = Router();

    router.get('/overview', async (_req, res) => {
        const [content, deviceCounts, people, records] = await Promise.all([
            db.execute(sql`
                SELECT collection, count(*)::int AS items, coalesce(sum(size), 0)::bigint AS bytes
                FROM content_items WHERE deleted_at IS NULL GROUP BY collection ORDER BY collection`),
            db.execute(sql`
                SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE status = 'active')::int AS active,
                       count(*) FILTER (WHERE last_seen_at > now() - interval '1 day')::int AS seen_24h,
                       count(*) FILTER (WHERE last_seen_at > now() - interval '7 days')::int AS seen_7d,
                       count(DISTINCT school->>'name') FILTER (WHERE coalesce(school->>'name', '') <> '')::int AS schools
                FROM devices`),
            db.execute(sql`
                SELECT coalesce(data->>'role', 'unknown') AS role, count(*)::int AS people
                FROM ${currentRecords('users')} u GROUP BY 1 ORDER BY people DESC`),
            db.execute(sql`
                SELECT entity, count(*)::int AS records, count(DISTINCT device_id)::int AS devices
                FROM box_records WHERE received_at > now() - interval '30 days'
                GROUP BY entity ORDER BY records DESC`),
        ]);
        res.json({
            content: content.rows.map(r => ({ ...r, bytes: Number(r.bytes) })),
            devices: deviceCounts.rows[0],
            people: people.rows,
            recordsLast30Days: records.rows,
        });
    });

    /** Usage events from all boxes, e.g. ?groupBy=district&type=item_opened&from=2026-09-01 */
    router.get('/usage', async (req, res) => {
        const q = usageQuery.parse(req.query);
        const { from, to } = range(q.from, q.to);

        const where: SQL[] = [sql`${eventTime} >= ${from}`, sql`${eventTime} < ${to}`];
        if (q.type) where.push(sql`ue.data->>'event_type' = ${q.type}`);
        if (q.deviceId) where.push(sql`ue.device_id = ${q.deviceId}`);
        if (q.district) where.push(sql`d.school->>'district' = ${q.district}`);

        let key: SQL;
        let label: SQL;
        let join = sql``;
        switch (q.groupBy) {
            case 'day':
            case 'week':
            case 'month':
                key = sql`to_char(date_trunc(${q.groupBy}, ${eventTime} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
                label = key;
                break;
            case 'type':
                key = sql`ue.data->>'event_type'`;
                label = key;
                break;
            case 'role':
                key = sql`coalesce(ue.data->>'role', 'unknown')`;
                label = key;
                break;
            case 'device':
                key = sql`ue.device_id::text`;
                label = sql`d.name`;
                break;
            case 'school':
                key = sql`coalesce(d.school->>'name', 'Unknown school')`;
                label = key;
                break;
            case 'district':
                key = sql`coalesce(d.school->>'district', 'Unknown district')`;
                label = key;
                break;
            case 'course':
                // Course ids are per box, so the key includes the box.
                join = sql`LEFT JOIN ${currentRecords('courses')} c
                    ON c.device_id = ue.device_id AND c.data->>'id' = ue.data->>'course_id'`;
                key = sql`ue.device_id::text || ':' || coalesce(ue.data->>'course_id', '')`;
                label = sql`coalesce(c.data->>'title', ue.data->>'course_id', 'No course')`;
                where.push(sql`ue.data->>'course_id' IS NOT NULL`);
                break;
            case 'content':
                // Library/Explore/catalogue opens carry the catalogue id when the file came from here.
                join = sql`LEFT JOIN content_items ci ON ci.id::text = ue.data->'data'->>'cloudContentId'`;
                key = sql`coalesce(ue.data->'data'->>'cloudContentId', ue.data->'data'->>'path', ue.data->'data'->>'title', 'unknown')`;
                label = sql`coalesce(ci.title, ue.data->'data'->>'title', ue.data->'data'->>'path', 'unknown')`;
                where.push(sql`ue.data->'data' ? 'source'`);
                break;
        }

        const orderBy = ['day', 'week', 'month'].includes(q.groupBy) ? sql`key ASC` : sql`events DESC`;
        const result = await db.execute(sql`
            SELECT ${key} AS key, ${label} AS label,
                   count(*)::int AS events,
                   count(DISTINCT ue.device_id::text || ':' || coalesce(ue.data->>'user_id', ''))
                       FILTER (WHERE ue.data->>'user_id' IS NOT NULL)::int AS unique_people,
                   count(DISTINCT ue.device_id)::int AS unique_devices
            FROM ${currentRecords('usage_events')} ue
            JOIN devices d ON d.id = ue.device_id
            ${join}
            WHERE ${sql.join(where, sql` AND `)}
            GROUP BY 1, 2
            ORDER BY ${orderBy}
            LIMIT ${q.limit}`);
        res.json({ from, to, groupBy: q.groupBy, rows: result.rows });
    });

    /** One row per box: identity, school, sync health, and what it holds. */
    router.get('/devices', async (_req, res) => {
        const result = await db.execute(sql`
            SELECT d.id, d.name, d.serial, d.location, d.status, d.box_id, d.last_seen_at, d.last_sync_at,
                   d.school->>'name' AS school_name, d.school->>'district' AS district, d.school->>'province' AS province,
                   d.hardware->>'model' AS model,
                   d.sync_history->0->>'status' AS last_run_status,
                   (d.sync_history->0->'details'->>'pending')::int AS pending_records,
                   coalesce(ck.checkins, 0)::int AS checkins_7d,
                   coalesce(rc.records, 0)::int AS records_30d,
                   coalesce(pp.learners, 0)::int AS learners,
                   coalesce(pp.teachers, 0)::int AS teachers,
                   coalesce(cs.courses, 0)::int AS courses
            FROM devices d
            LEFT JOIN (SELECT device_id, count(*) AS checkins FROM device_checkins
                       WHERE received_at > now() - interval '7 days' GROUP BY device_id) ck ON ck.device_id = d.id
            LEFT JOIN (SELECT device_id, count(*) AS records FROM box_records
                       WHERE received_at > now() - interval '30 days' GROUP BY device_id) rc ON rc.device_id = d.id
            LEFT JOIN (SELECT device_id,
                              count(*) FILTER (WHERE data->>'role' = 'scholar') AS learners,
                              count(*) FILTER (WHERE data->>'role' = 'teacher') AS teachers
                       FROM ${currentRecords('users')} u GROUP BY device_id) pp ON pp.device_id = d.id
            LEFT JOIN (SELECT device_id, count(*) AS courses FROM ${currentRecords('courses')} c GROUP BY device_id) cs
                   ON cs.device_id = d.id
            ORDER BY d.last_seen_at DESC NULLS LAST, d.name`);
        res.json(result.rows);
    });

    /** Boxes grouped by school (as each box's admin set it up). */
    router.get('/schools', async (_req, res) => {
        const result = await db.execute(sql`
            SELECT d.school->>'name' AS school_name, d.school->>'code' AS school_code,
                   d.school->>'district' AS district, d.school->>'province' AS province,
                   (d.school->>'isRural')::boolean AS is_rural,
                   count(DISTINCT d.id)::int AS boxes,
                   max(d.last_seen_at) AS last_seen_at,
                   coalesce(sum(pp.learners), 0)::int AS learners,
                   coalesce(sum(pp.teachers), 0)::int AS teachers
            FROM devices d
            LEFT JOIN (SELECT device_id,
                              count(*) FILTER (WHERE data->>'role' = 'scholar') AS learners,
                              count(*) FILTER (WHERE data->>'role' = 'teacher') AS teachers
                       FROM ${currentRecords('users')} u GROUP BY device_id) pp ON pp.device_id = d.id
            WHERE coalesce(d.school->>'name', '') <> ''
            GROUP BY 1, 2, 3, 4, 5
            ORDER BY learners DESC, school_name`);
        res.json(result.rows);
    });

    /** Reach of one catalogue item: opens on boxes, by type and box. */
    router.get('/content/:id', async (req, res) => {
        const id = String(idParam.parse(req.params.id));
        const result = await db.execute(sql`
            SELECT ue.data->>'event_type' AS type, count(*)::int AS events,
                   count(DISTINCT ue.device_id)::int AS unique_devices,
                   count(DISTINCT ue.device_id::text || ':' || coalesce(ue.data->>'user_id', ''))
                       FILTER (WHERE ue.data->>'user_id' IS NOT NULL)::int AS unique_people
            FROM ${currentRecords('usage_events')} ue
            WHERE ue.data->'data'->>'cloudContentId' = ${id}
            GROUP BY 1 ORDER BY events DESC`);
        res.json({ contentId: Number(id), usage: result.rows });
    });

    return router;
}
