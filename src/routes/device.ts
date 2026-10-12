import { Router } from 'express';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import {
    COLLECTIONS,
    contentItems,
    deviceHeartbeats,
    deviceInventory,
    devices,
    usageEvents,
    type Collection,
} from '../db/schema.js';
import { currentDevice, requireDevice } from '../http/auth.js';
import { idParam, notFound } from '../http/errors.js';
import { contentToApi, deviceToApi } from '../http/serialize.js';
import { normalizeRelPath, toAbsPath, type CollectionRoots } from '../ingest/paths.js';

const collection = z.enum(COLLECTIONS);
const relPath = z
    .string()
    .max(1024)
    .transform((p, ctx) => {
        const n = normalizeRelPath(p);
        if (!n) ctx.addIssue({ code: 'custom', message: 'Invalid path' });
        return n ?? '';
    });
const extra = z.record(z.string(), z.unknown()).optional();
const nonNegInt = z.number().int().nonnegative();

const syncQuery = z.object({
    since: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
    collection: collection.optional(),
});

const heartbeatBody = z.object({
    reportedAt: z.iso.datetime({ offset: true }).optional(),
    softwareVersion: z.string().max(100).optional(),
    uptimeSeconds: nonNegInt.optional(),
    disk: z.object({ totalBytes: nonNegInt, freeBytes: nonNegInt }).optional(),
    memory: z.object({ totalBytes: nonNegInt, freeBytes: nonNegInt }).optional(),
    cpuLoad: z.number().nonnegative().optional(),
    connectedClients: nonNegInt.optional(),
    // Last /api/v1/sync cursor the device fully applied.
    syncCursor: nonNegInt.optional(),
    extra,
});

const inventoryBody = z.object({
    items: z
        .array(
            z
                .object({
                    collection,
                    path: relPath.optional(),
                    contentId: z.number().int().positive().optional(),
                    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
                    size: nonNegInt.optional(),
                })
                .refine(i => i.path || i.contentId, { message: 'path or contentId is required' }),
        )
        .max(100_000),
});

const MAX_DURATION = 7 * 24 * 3600;
const eventsBody = z.object({
    // Device clock when the batch was sent; used to correct boxes with a wrong clock.
    sentAt: z.iso.datetime({ offset: true }).optional(),
    events: z
        .array(
            z.object({
                id: z.string().min(1).max(100),
                type: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/, 'lowercase type like "view" or "video.complete"'),
                occurredAt: z.iso.datetime({ offset: true }),
                contentId: z.number().int().positive().optional(),
                collection: collection.optional(),
                path: relPath.optional(),
                learnerRef: z.string().max(200).optional(),
                sessionRef: z.string().max(200).optional(),
                durationSeconds: z.number().int().min(0).max(MAX_DURATION).optional(),
                progress: z.number().min(0).max(1).optional(),
                extra,
            }),
        )
        .min(1)
        .max(1000),
});

// Only correct clocks that are clearly wrong; small drift is left alone.
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

const keyOf = (c: Collection, p: string) => `${c}\u0000${p}`;

export function deviceRouter(db: Db, roots: CollectionRoots): Router {
    const router = Router();
    router.use(requireDevice(db));

    router.get('/devices/me', (_req, res) => {
        res.json(deviceToApi(currentDevice(res)));
    });

    /**
     * Changes since a cursor. Start with since=0 (deleted items are skipped on
     * a first sync), store `nextCursor`, repeat while `hasMore`.
     */
    router.get('/sync', async (req, res) => {
        const q = syncQuery.parse(req.query);
        const where = [gt(contentItems.changeSeq, q.since)];
        if (q.collection) where.push(eq(contentItems.collection, q.collection));
        if (q.since === 0) where.push(isNull(contentItems.deletedAt));

        const rows = await db
            .select()
            .from(contentItems)
            .where(and(...where))
            .orderBy(asc(contentItems.changeSeq))
            .limit(q.limit + 1);
        const page = rows.slice(0, q.limit);
        const nextCursor = page.length ? page.at(-1)!.changeSeq : q.since;

        await db.update(devices).set({ lastSyncAt: new Date() }).where(eq(devices.id, currentDevice(res).id));
        res.json({ items: page.map(contentToApi), nextCursor, hasMore: rows.length > q.limit });
    });

    router.get('/content/:id/file', async (req, res) => {
        const id = idParam.parse(req.params.id);
        const [item] = await db
            .select()
            .from(contentItems)
            .where(and(eq(contentItems.id, id), isNull(contentItems.deletedAt)));
        if (!item) throw notFound('Content not found');
        res.setHeader('X-Content-SHA256', item.sha256);
        res.setHeader('X-Content-Version', String(item.version));
        res.sendFile(toAbsPath(roots[item.collection], item.path), { dotfiles: 'deny' });
    });

    router.post('/devices/me/heartbeat', async (req, res) => {
        const body = heartbeatBody.parse(req.body);
        const device = currentDevice(res);
        await db.insert(deviceHeartbeats).values({
            deviceId: device.id,
            reportedAt: body.reportedAt ? new Date(body.reportedAt) : null,
            softwareVersion: body.softwareVersion ?? null,
            uptimeSeconds: body.uptimeSeconds ?? null,
            diskTotalBytes: body.disk?.totalBytes ?? null,
            diskFreeBytes: body.disk?.freeBytes ?? null,
            memTotalBytes: body.memory?.totalBytes ?? null,
            memFreeBytes: body.memory?.freeBytes ?? null,
            cpuLoad: body.cpuLoad ?? null,
            connectedClients: body.connectedClients ?? null,
            extra: body.extra ?? null,
        });
        await db
            .update(devices)
            .set({
                lastSeenAt: new Date(),
                lastIp: req.ip ?? null,
                latestHealth: body,
                updatedAt: new Date(),
                ...(body.softwareVersion ? { softwareVersion: body.softwareVersion } : {}),
                ...(body.syncCursor !== undefined ? { lastSyncCursor: body.syncCursor } : {}),
            })
            .where(eq(devices.id, device.id));
        res.status(204).end();
    });

    /** Full list of what is installed on the box; replaces the previous report. */
    router.put('/devices/me/inventory', async (req, res) => {
        const { items } = inventoryBody.parse(req.body);
        const device = currentDevice(res);

        const ids = [...new Set(items.flatMap(i => (i.contentId ? [i.contentId] : [])))];
        const paths = items.filter(i => i.path);
        const known = new Map<string, { id: number; collection: Collection; path: string; sha256: string }>();
        const byId = new Map<number, { id: number; collection: Collection; path: string; sha256: string }>();
        const cols = {
            id: contentItems.id,
            collection: contentItems.collection,
            path: contentItems.path,
            sha256: contentItems.sha256,
        };
        for (let i = 0; i < ids.length; i += 5000) {
            for (const r of await db.select(cols).from(contentItems).where(inArray(contentItems.id, ids.slice(i, i + 5000)))) {
                byId.set(r.id, r);
            }
        }
        for (const c of COLLECTIONS) {
            const ps = [...new Set(paths.filter(i => i.collection === c).map(i => i.path!))];
            for (let i = 0; i < ps.length; i += 5000) {
                const rows = await db
                    .select(cols)
                    .from(contentItems)
                    .where(and(eq(contentItems.collection, c), inArray(contentItems.path, ps.slice(i, i + 5000))));
                for (const r of rows) known.set(keyOf(r.collection, r.path), r);
            }
        }

        let unknown = 0;
        let outdated = 0;
        const rows = new Map<string, typeof deviceInventory.$inferInsert>();
        const now = new Date();
        for (const i of items) {
            const match = (i.contentId ? byId.get(i.contentId) : undefined) ?? (i.path ? known.get(keyOf(i.collection, i.path)) : undefined);
            const p = i.path ?? match?.path;
            if (!p) {
                unknown++;
                continue;
            }
            if (!match) unknown++;
            else if (i.sha256 && i.sha256 !== match.sha256) outdated++;
            rows.set(keyOf(i.collection, p), {
                deviceId: device.id,
                collection: i.collection,
                path: p,
                contentItemId: match?.id ?? null,
                sha256: i.sha256 ?? null,
                size: i.size ?? null,
                reportedAt: now,
            });
        }

        await db.transaction(async tx => {
            await tx.delete(deviceInventory).where(eq(deviceInventory.deviceId, device.id));
            const values = [...rows.values()];
            for (let i = 0; i < values.length; i += 1000) await tx.insert(deviceInventory).values(values.slice(i, i + 1000));
        });
        res.json({ stored: rows.size, unknown, outdated });
    });

    /** Batched usage events. Safe to retry: duplicates (same event id) are ignored. */
    router.post('/devices/me/events', async (req, res) => {
        const body = eventsBody.parse(req.body);
        const device = currentDevice(res);

        let skewMs = 0;
        if (body.sentAt) {
            const diff = Date.now() - new Date(body.sentAt).getTime();
            if (Math.abs(diff) > CLOCK_SKEW_TOLERANCE_MS) skewMs = diff;
        }

        // Resolve content references; unknown ids are kept as path-only events instead of failing the batch.
        const ids = [...new Set(body.events.flatMap(e => (e.contentId ? [e.contentId] : [])))];
        const idRows = ids.length
            ? await db
                  .select({ id: contentItems.id, collection: contentItems.collection, path: contentItems.path })
                  .from(contentItems)
                  .where(inArray(contentItems.id, ids))
            : [];
        const byId = new Map(idRows.map(r => [r.id, r]));
        const byPath = new Map<string, number>();
        for (const c of COLLECTIONS) {
            const ps = [...new Set(body.events.filter(e => !e.contentId && e.path && e.collection === c).map(e => e.path!))];
            if (!ps.length) continue;
            const rows = await db
                .select({ id: contentItems.id, path: contentItems.path })
                .from(contentItems)
                .where(and(eq(contentItems.collection, c), inArray(contentItems.path, ps)));
            for (const r of rows) byPath.set(keyOf(c, r.path), r.id);
        }

        const values = body.events.map(e => {
            const ref = e.contentId ? byId.get(e.contentId) : undefined;
            const contentItemId =
                ref?.id ?? (e.collection && e.path ? (byPath.get(keyOf(e.collection, e.path)) ?? null) : null);
            const occurred = new Date(new Date(e.occurredAt).getTime() + skewMs);
            const extraOut = { ...(e.extra ?? {}), ...(skewMs ? { clockSkewMs: skewMs, rawOccurredAt: e.occurredAt } : {}) };
            return {
                deviceId: device.id,
                clientEventId: e.id,
                type: e.type,
                contentItemId,
                collection: ref?.collection ?? e.collection ?? null,
                path: ref?.path ?? e.path ?? null,
                learnerRef: e.learnerRef ?? null,
                sessionRef: e.sessionRef ?? null,
                durationSeconds: e.durationSeconds ?? null,
                progress: e.progress ?? null,
                occurredAt: occurred,
                extra: Object.keys(extraOut).length ? extraOut : null,
            };
        });

        const inserted = await db
            .insert(usageEvents)
            .values(values)
            .onConflictDoNothing({ target: [usageEvents.deviceId, usageEvents.clientEventId] })
            .returning({ id: usageEvents.id });
        res.json({ accepted: inserted.length, duplicates: values.length - inserted.length, clockSkewMs: skewMs });
    });

    return router;
}
