import { Router } from 'express';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { boxRecords, COLLECTIONS, contentItems, deviceCheckins, devices } from '../db/schema.js';
import { currentDevice, requireDevice } from '../http/auth.js';
import { idParam, notFound } from '../http/errors.js';
import { contentToApi, deviceToApi } from '../http/serialize.js';
import { toAbsPath, type CollectionRoots } from '../ingest/paths.js';

const syncQuery = z.object({
    since: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
    collection: z.enum(COLLECTIONS).optional(),
});

const jsonObject = z.record(z.string(), z.unknown());

/**
 * What a box's sync outbox posts (somabox-lms src/services/sync/transports.js):
 * { boxId, device, school, history, records: [{ syncId, boxId, entity, op, entitySyncId, occurredAt, data }] }.
 * A run with nothing new sends records: [] as a heartbeat.
 */
const boxSyncBody = z.object({
    boxId: z.string().max(200).nullish(),
    device: jsonObject.nullish(),
    school: jsonObject.nullish(),
    history: z.array(z.unknown()).max(200).nullish(),
    records: z.array(z.unknown()).max(5000).default([]),
});

// Lenient on purpose: rejecting a whole batch would stall the box's outbox forever, so only
// records without a usable id or entity are dropped (and logged).
const boxRecord = z.object({
    syncId: z.guid(),
    entity: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
    op: z.string().min(1).max(20),
    entitySyncId: z.guid().nullish(),
    occurredAt: z.union([z.string(), z.number()]).nullish(),
    data: jsonObject.nullish(),
});

function toDate(v: string | number | null | undefined, fallback: Date): Date {
    if (v === null || v === undefined) return fallback;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? fallback : d;
}

function isUniqueViolation(err: unknown) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === '23505' || e?.cause?.code === '23505';
}

export function deviceRouter(db: Db, roots: CollectionRoots): Router {
    const router = Router();
    router.use(requireDevice(db));

    router.get('/devices/me', (_req, res) => {
        res.json(deviceToApi(currentDevice(res)));
    });

    /**
     * Content catalogue changes since a cursor. Start with since=0 (deleted items are skipped on
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

    /** Receiver for the box's sync outbox. Set SYNC_URL to this endpoint and SYNC_TOKEN to the box's key. */
    router.post('/box-sync', async (req, res) => {
        const body = boxSyncBody.parse(req.body);
        const device = currentDevice(res);
        const now = new Date();

        const values: (typeof boxRecords.$inferInsert)[] = [];
        const rejected: { index: number; reason: string }[] = [];
        body.records.forEach((raw, index) => {
            const r = boxRecord.safeParse(raw);
            if (!r.success) {
                rejected.push({ index, reason: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') });
                return;
            }
            const { password_hash: _never, ...data } = r.data.data ?? {};
            values.push({
                syncId: r.data.syncId,
                deviceId: device.id,
                boxId: body.boxId ?? null,
                entity: r.data.entity,
                op: r.data.op,
                entitySyncId: r.data.entitySyncId ?? null,
                occurredAt: toDate(r.data.occurredAt, now),
                data,
            });
        });
        if (rejected.length) {
            console.warn(`[box-sync] ${device.name}: dropped ${rejected.length} malformed record(s)`, rejected.slice(0, 3));
        }

        let accepted = 0;
        for (let i = 0; i < values.length; i += 500) {
            const inserted = await db
                .insert(boxRecords)
                .values(values.slice(i, i + 500))
                .onConflictDoNothing({ target: boxRecords.syncId })
                .returning({ syncId: boxRecords.syncId });
            accepted += inserted.length;
        }

        if (body.boxId && device.boxId && device.boxId !== body.boxId) {
            console.warn(`[box-sync] ${device.name}: box id changed ${device.boxId} -> ${body.boxId} (reinstalled, or key reused on another box)`);
        }
        const history = body.history ?? null;
        const lastRun = Array.isArray(history) ? (history[0] as { status?: unknown } | undefined) : undefined;
        await db
            .update(devices)
            .set({
                lastSeenAt: now,
                lastIp: req.ip ?? null,
                updatedAt: now,
                ...(body.boxId ? { boxId: body.boxId } : {}),
                ...(body.device ? { hardware: body.device } : {}),
                ...(body.school ? { school: body.school } : {}),
                ...(history ? { syncHistory: history } : {}),
            })
            .where(eq(devices.id, device.id));

        // Fill in the serial from the hardware report unless an admin already set one.
        const serial = typeof body.device?.serialNumber === 'string' ? body.device.serialNumber.trim() : '';
        if (serial && !device.serial) {
            await db
                .update(devices)
                .set({ serial })
                .where(and(eq(devices.id, device.id), isNull(devices.serial)))
                .catch(err => {
                    if (!isUniqueViolation(err)) throw err;
                    console.warn(`[box-sync] ${device.name}: serial ${serial} already belongs to another device`);
                });
        }

        await db.insert(deviceCheckins).values({
            deviceId: device.id,
            boxId: body.boxId ?? null,
            records: body.records.length,
            accepted,
            lastRunStatus: typeof lastRun?.status === 'string' ? lastRun.status : null,
            ip: req.ip ?? null,
        });

        res.json({ accepted, duplicates: values.length - accepted, rejected: rejected.length });
    });

    return router;
}
