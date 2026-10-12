import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { RequestHandler, Response } from 'express';
import type { Db } from '../db/client.js';
import { devices, type Device } from '../db/schema.js';
import { HttpError } from './errors.js';

const KEY_PREFIX = 'sbx_';

export function hashKey(key: string): string {
    return createHash('sha256').update(key).digest('hex');
}

/** New device API key. Only the hash is stored; the key is shown once. */
export function generateDeviceKey(): { key: string; hash: string; prefix: string } {
    const key = KEY_PREFIX + randomBytes(32).toString('base64url');
    return { key, hash: hashKey(key), prefix: key.slice(0, KEY_PREFIX.length + 8) };
}

function bearer(header: string | undefined): string | null {
    const m = header?.match(/^Bearer\s+(.+)$/i);
    return m?.[1]?.trim() || null;
}

export function requireAdmin(adminToken: string): RequestHandler {
    const expected = Buffer.from(adminToken);
    return (req, _res, next) => {
        const token = bearer(req.headers.authorization);
        const given = Buffer.from(token ?? '');
        if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) {
            return next(new HttpError(401, 'Admin token required'));
        }
        next();
    };
}

export function requireDevice(db: Db): RequestHandler {
    return async (req, res, next) => {
        const token = bearer(req.headers.authorization);
        if (!token?.startsWith(KEY_PREFIX)) return next(new HttpError(401, 'Device API key required'));
        const [device] = await db.select().from(devices).where(eq(devices.apiKeyHash, hashKey(token)));
        if (!device) return next(new HttpError(401, 'Unknown device key'));
        if (device.status !== 'active') return next(new HttpError(403, 'Device is revoked'));
        res.locals.device = device;

        // Track presence without writing on every request.
        await db
            .update(devices)
            .set({ lastSeenAt: new Date(), lastIp: req.ip ?? null })
            .where(
                and(
                    eq(devices.id, device.id),
                    or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, sql`now() - interval '1 minute'`)),
                ),
            );
        next();
    };
}

export function currentDevice(res: Response): Device {
    return res.locals.device as Device;
}
