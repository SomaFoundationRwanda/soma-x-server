import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { RequestHandler, Response } from 'express';
import type { Db } from '../db/client.js';
import { adminAudit, apiTokens, devices, type ApiScope, type Device } from '../db/schema.js';
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

const API_TOKEN_PREFIX = 'sxa_';

/** New scoped API token. Only the hash is stored; the token is shown once. */
export function generateApiToken(): { token: string; hash: string; prefix: string } {
    const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    return { token, hash: hashKey(token), prefix: token.slice(0, API_TOKEN_PREFIX.length + 8) };
}

export interface Principal {
    tokenId: string | null; // null = ADMIN_TOKEN
    name: string;
    scopes: readonly string[] | 'all';
}

/** What an admin request needs: reads need "read"; changes need the area's write scope. */
export function scopeFor(method: string, path: string): ApiScope {
    if (method === 'GET' || method === 'HEAD') return 'read';
    if (path.startsWith('/devices')) return 'devices:write';
    return 'content:write';
}

/**
 * Admin API authentication: the root ADMIN_TOKEN (everything) or a scoped API token. Changes are
 * written to admin_audit with the person the calling service acted for (X-Actor header).
 */
export function requireAdmin(db: Db, adminToken: string): RequestHandler {
    const expected = Buffer.from(adminToken);
    return async (req, res, next) => {
        const token = bearer(req.headers.authorization);
        if (!token) return next(new HttpError(401, 'Admin token required'));

        let principal: Principal | null = null;
        const given = Buffer.from(token);
        if (given.length === expected.length && timingSafeEqual(given, expected)) {
            principal = { tokenId: null, name: 'ADMIN_TOKEN', scopes: 'all' };
        } else if (token.startsWith(API_TOKEN_PREFIX)) {
            const [row] = await db
                .select()
                .from(apiTokens)
                .where(and(eq(apiTokens.tokenHash, hashKey(token)), isNull(apiTokens.revokedAt)));
            if (row) {
                principal = { tokenId: row.id, name: row.name, scopes: row.scopes };
                await db
                    .update(apiTokens)
                    .set({ lastUsedAt: new Date() })
                    .where(
                        and(
                            eq(apiTokens.id, row.id),
                            or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, sql`now() - interval '1 minute'`)),
                        ),
                    );
            }
        }
        if (!principal) return next(new HttpError(401, 'Invalid admin token'));

        const needed = scopeFor(req.method, req.path);
        if (principal.scopes !== 'all' && !principal.scopes.includes(needed)) {
            return next(new HttpError(403, `This token lacks the "${needed}" scope`));
        }
        res.locals.principal = principal;

        if (needed !== 'read') {
            const actor = typeof req.headers['x-actor'] === 'string' ? req.headers['x-actor'].slice(0, 200) : null;
            res.on('finish', () => {
                db.insert(adminAudit)
                    .values({
                        tokenId: principal.tokenId,
                        tokenName: principal.name,
                        actor,
                        method: req.method,
                        path: req.originalUrl.slice(0, 1000),
                        status: res.statusCode,
                        ip: req.ip ?? null,
                    })
                    .catch(err => console.error('[audit] could not record', err));
            });
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
