import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { COLLECTIONS, contentItems, devices } from '../db/schema.js';
import { generateDeviceKey } from '../http/auth.js';
import { HttpError, idParam, notFound } from '../http/errors.js';
import { contentToApi, deviceToApi } from '../http/serialize.js';
import type { Indexer, ReconcileStats } from '../ingest/indexer.js';
import { isIgnoredRelPath, normalizeRelPath, toAbsPath } from '../ingest/paths.js';
import { statsRouter } from './stats.js';

const collection = z.enum(COLLECTIONS);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

// Multipart fields arrive as strings; accept "a,b" or repeated fields.
const categoriesField = z
    .union([z.string(), z.array(z.string())])
    .transform(v => (Array.isArray(v) ? v : v.split(',')).map(s => s.trim()).filter(Boolean));
const boolField = z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .transform(v => v === true || v === 'true' || v === '1');

const uploadBody = z.object({
    collection,
    // Folder inside the collection, e.g. "primary/p4/maths". Optional.
    folder: z.string().max(1024).optional(),
    // Override the stored filename (defaults to the uploaded file's name).
    filename: z.string().max(255).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    author: z.string().trim().max(500).optional(),
    description: z.string().trim().max(5000).optional(),
    categories: categoriesField.optional(),
    overwrite: boolField.default(false),
});

const patchBody = z
    .object({
        title: z.string().trim().min(1).max(500).optional(),
        author: optionalText(500),
        description: optionalText(5000),
        categories: z.array(z.string().max(100)).max(50).optional(),
    })
    .refine(b => Object.values(b).some(v => v !== undefined), { message: 'Nothing to update' });

const listQuery = z.object({
    collection: collection.optional(),
    q: z.string().max(200).optional(),
    category: z.string().max(100).optional(),
    includeDeleted: boolField.default(false),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
});

const deviceCreate = z.object({
    name: z.string().trim().min(1).max(200),
    serial: z.string().trim().min(1).max(200).optional(),
    location: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(5000).optional(),
});
const devicePatch = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    serial: optionalText(200),
    location: optionalText(500),
    notes: optionalText(5000),
    status: z.enum(['active', 'revoked']).optional(),
});

async function moveFile(from: string, to: string) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
        await fs.rename(from, to);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await fs.copyFile(from, to);
        await fs.unlink(from);
    }
}

function isUniqueViolation(err: unknown) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === '23505' || e?.cause?.code === '23505';
}

export function adminRouter(db: Db, indexer: Indexer, opts: { uploadTmpDir: string; maxUploadBytes: number }): Router {
    const router = Router();
    const upload = multer({
        dest: opts.uploadTmpDir,
        limits: { fileSize: opts.maxUploadBytes, files: 1 },
        // Keep non-ASCII filenames intact (busboy defaults to latin1).
        defParamCharset: 'utf8',
    });

    // ---- content ----

    router.get('/content', async (req, res) => {
        const q = listQuery.parse(req.query);
        const where: SQL[] = [];
        if (q.collection) where.push(eq(contentItems.collection, q.collection));
        if (!q.includeDeleted) where.push(isNull(contentItems.deletedAt));
        if (q.category) where.push(sql`${q.category.toLowerCase()} = ANY(${contentItems.categories})`);
        if (q.q) {
            const pattern = `%${q.q.replace(/[\\%_]/g, m => '\\' + m)}%`;
            where.push(or(ilike(contentItems.title, pattern), ilike(contentItems.path, pattern))!);
        }
        const cond = where.length ? and(...where) : undefined;
        const [rows, [count]] = await Promise.all([
            db
                .select()
                .from(contentItems)
                .where(cond)
                .orderBy(asc(contentItems.collection), asc(contentItems.path))
                .limit(q.limit)
                .offset(q.offset),
            db.select({ n: sql<number>`count(*)::int` }).from(contentItems).where(cond),
        ]);
        res.json({ items: rows.map(contentToApi), total: count?.n ?? 0, limit: q.limit, offset: q.offset });
    });

    router.get('/content/:id', async (req, res) => {
        const [item] = await db.select().from(contentItems).where(eq(contentItems.id, idParam.parse(req.params.id)));
        if (!item) throw notFound('Content not found');
        res.json(contentToApi(item));
    });

    /** multipart/form-data: file + collection [+ folder, filename, title, author, description, categories, overwrite] */
    router.post('/content', upload.single('file'), async (req, res) => {
        const tmp = req.file?.path;
        try {
            if (!req.file) throw new HttpError(400, 'Missing "file" field');
            const body = uploadBody.parse(req.body);

            const name = path.basename((body.filename ?? req.file.originalname).replace(/\\/g, '/'));
            const folder = body.folder?.trim() ? normalizeRelPath(body.folder) : '';
            if (folder === null) throw new HttpError(400, 'Invalid folder');
            const rel = normalizeRelPath(folder ? `${folder}/${name}` : name);
            if (!rel || isIgnoredRelPath(rel) || !path.extname(rel)) {
                throw new HttpError(400, 'Invalid filename (hidden, temporary, or missing an extension)');
            }

            const abs = toAbsPath(indexer.roots[body.collection], rel);
            const exists = await fs.stat(abs).then(() => true, () => false);
            if (exists && !body.overwrite) {
                throw new HttpError(409, `File already exists: ${body.collection}/${rel}. Send overwrite=true to replace it.`);
            }
            await moveFile(req.file.path, abs);

            const result = await indexer.indexFile(body.collection, rel, {
                source: 'upload',
                overrides: {
                    title: body.title,
                    author: body.author,
                    description: body.description,
                    categories: body.categories,
                },
            });
            if (!('item' in result)) throw new HttpError(500, 'File could not be indexed');
            res.status(result.status === 'created' ? 201 : 200).json({ status: result.status, item: contentToApi(result.item) });
        } finally {
            if (tmp) await fs.unlink(tmp).catch(() => {});
        }
    });

    router.patch('/content/:id', async (req, res) => {
        const item = await indexer.updateMetadata(idParam.parse(req.params.id), patchBody.parse(req.body));
        if (!item) throw notFound('Content not found');
        res.json(contentToApi(item));
    });

    /** Deletes the file from disk and marks it deleted so devices drop it on next sync. */
    router.delete('/content/:id', async (req, res) => {
        const [item] = await db
            .select()
            .from(contentItems)
            .where(and(eq(contentItems.id, idParam.parse(req.params.id)), isNull(contentItems.deletedAt)));
        if (!item) throw notFound('Content not found');
        await fs.rm(toAbsPath(indexer.roots[item.collection], item.path), { force: true });
        await indexer.markDeleted(item.collection, item.path);
        res.status(204).end();
    });

    let reconciling: Promise<ReconcileStats> | null = null;
    router.post('/reindex', async (_req, res) => {
        reconciling ??= indexer.reconcile().finally(() => (reconciling = null));
        res.json(await reconciling);
    });

    // ---- devices ----

    router.post('/devices', async (req, res) => {
        const body = deviceCreate.parse(req.body);
        const key = generateDeviceKey();
        try {
            const [device] = await db
                .insert(devices)
                .values({ ...body, apiKeyHash: key.hash, apiKeyPrefix: key.prefix })
                .returning();
            // The key is only ever returned here; store it on the device.
            res.status(201).json({ device: deviceToApi(device!), apiKey: key.key });
        } catch (err) {
            if (isUniqueViolation(err)) throw new HttpError(409, 'A device with this serial already exists');
            throw err;
        }
    });

    router.get('/devices', async (_req, res) => {
        const rows = await db.select().from(devices).orderBy(desc(devices.lastSeenAt), asc(devices.name));
        res.json(rows.map(deviceToApi));
    });

    const deviceId = z.uuid();
    router.get('/devices/:id', async (req, res) => {
        const [device] = await db.select().from(devices).where(eq(devices.id, deviceId.parse(req.params.id)));
        if (!device) throw notFound('Device not found');
        res.json(deviceToApi(device));
    });

    router.patch('/devices/:id', async (req, res) => {
        const body = devicePatch.parse(req.body);
        try {
            const [device] = await db
                .update(devices)
                .set({ ...body, updatedAt: new Date() })
                .where(eq(devices.id, deviceId.parse(req.params.id)))
                .returning();
            if (!device) throw notFound('Device not found');
            res.json(deviceToApi(device));
        } catch (err) {
            if (isUniqueViolation(err)) throw new HttpError(409, 'A device with this serial already exists');
            throw err;
        }
    });

    router.post('/devices/:id/rotate-key', async (req, res) => {
        const key = generateDeviceKey();
        const [device] = await db
            .update(devices)
            .set({ apiKeyHash: key.hash, apiKeyPrefix: key.prefix, updatedAt: new Date() })
            .where(eq(devices.id, deviceId.parse(req.params.id)))
            .returning();
        if (!device) throw notFound('Device not found');
        res.json({ device: deviceToApi(device), apiKey: key.key });
    });

    router.use('/stats', statsRouter(db));
    return router;
}
