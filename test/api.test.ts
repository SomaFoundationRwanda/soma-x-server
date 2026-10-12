import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { Indexer } from '../src/ingest/indexer.js';
import { startWatcher } from '../src/ingest/watcher.js';

const ADMIN = 'test-admin-token-0123456789abcdef';
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres:///somax_test';

let tmp: string;
let ctx: ReturnType<typeof createDb>;
let indexer: Indexer;
let app: ReturnType<typeof createApp>;
let deviceKey: string;
let deviceId: string;

const admin = (r: request.Test) => r.set('Authorization', `Bearer ${ADMIN}`);
const dev = (r: request.Test) => r.set('Authorization', `Bearer ${deviceKey}`);

function makeEpub(title: string, author: string): Buffer {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/epub+zip'));
    zip.addFile(
        'META-INF/container.xml',
        Buffer.from(
            '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        ),
    );
    zip.addFile(
        'OEBPS/content.opf',
        Buffer.from(
            `<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>${title}</dc:title><dc:creator>${author}</dc:creator></metadata></package>`,
        ),
    );
    return zip.toBuffer();
}

async function makePdf(pages: number): Promise<Buffer> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage();
    return Buffer.from(await doc.save());
}

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out');
        await new Promise(r => setTimeout(r, 250));
    }
}

beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'somax-test-'));
    const config = loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL,
        ADMIN_TOKEN: ADMIN,
        CONTENT_ROOT: path.join(tmp, 'content'),
        DATA_DIR: path.join(tmp, 'data'),
    });
    ctx = createDb(config.databaseUrl);
    await ctx.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(ctx.db);
    await fs.mkdir(config.uploadTmpDir, { recursive: true });
    indexer = new Indexer(ctx.db, config.collections, config.ffprobePath);
    await indexer.ensureRoots();
    app = createApp({ config, db: ctx.db, indexer });

    const res = await admin(request(app).post('/api/v1/admin/devices')).send({ name: 'Test box', serial: 'SBX-1' });
    expect(res.status).toBe(201);
    deviceKey = res.body.apiKey;
    deviceId = res.body.device.id;
});

afterAll(async () => {
    await ctx?.pool.end();
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

describe('legacy endpoints (deployed SomaBoxes)', () => {
    it('serves an empty catalogue', async () => {
        expect((await request(app).get('/metadata')).body).toEqual([]);
        expect((await request(app).get('/library-metadata')).body).toEqual([]);
    });

    it('builds /metadata from files dropped on disk, in the old tree shape', async () => {
        const root = indexer.roots.curriculum;
        await fs.mkdir(path.join(root, 'primary-4', 'maths'), { recursive: true });
        await fs.writeFile(path.join(root, 'primary-4', 'maths', 'unit-10.txt'), 'ten');
        await fs.writeFile(path.join(root, 'primary-4', 'maths', 'unit-2.txt'), 'two');
        await fs.writeFile(path.join(root, 'come.txt'), 'hello!!!');
        await fs.writeFile(path.join(root, '.DS_Store'), 'junk');
        await fs.writeFile(path.join(root, 'half.mp4.part'), 'junk');

        const stats = await indexer.reconcile();
        expect(stats).toMatchObject({ created: 3, failed: 0 });

        const res = await request(app).get('/metadata');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject([
            { type: 'file', name: 'Come.txt', path: 'come.txt', size: 8 },
            {
                type: 'folder',
                name: 'Primary 4',
                path: 'primary-4',
                children: [
                    {
                        type: 'folder',
                        name: 'Maths',
                        path: 'primary-4/maths',
                        children: [
                            { type: 'file', name: 'Unit 2.txt', path: 'primary-4/maths/unit-2.txt', size: 3 },
                            { type: 'file', name: 'Unit 10.txt', path: 'primary-4/maths/unit-10.txt', size: 3 },
                        ],
                    },
                ],
            },
        ]);
    });

    it('serves curriculum files at /content/<encodeURIComponent(path)> like the device requests them', async () => {
        const url = `/content/${encodeURIComponent('primary-4/maths/unit-10.txt')}`;
        const head = await request(app).head(url);
        expect(head.status).toBe(200);
        expect(head.headers['content-length']).toBe('3');
        expect((await request(app).get(url)).text).toBe('ten');
    });

    it('lists uploaded EPUBs in /library-metadata and serves them as /content/library/<id>.epub', async () => {
        const up = await admin(request(app).post('/api/v1/admin/content'))
            .field('collection', 'library')
            .field('folder', 'Science')
            .field('categories', 'science, Biology')
            .attach('file', makeEpub('The Cell &amp; You', 'A. Author'), 'cell.epub');
        expect(up.status).toBe(201);
        expect(up.body.item).toMatchObject({ title: 'The Cell & You', author: 'A. Author', categories: ['science', 'biology'] });

        const meta = await request(app).get('/library-metadata');
        expect(meta.body).toEqual([
            expect.objectContaining({ id: String(up.body.item.id), book_name: 'The Cell & You', categories: 'science,biology' }),
        ]);
        const file = await request(app).get(`/content/library/${up.body.item.id}.epub`).buffer(true);
        expect(file.status).toBe(200);
        expect(Number(file.headers['content-length'])).toBe(up.body.item.size);
    });
});

describe('admin content API', () => {
    it('requires the admin token', async () => {
        expect((await request(app).get('/api/v1/admin/content')).status).toBe(401);
        expect((await request(app).get('/api/v1/admin/content').set('Authorization', 'Bearer nope')).status).toBe(401);
    });

    it('extracts PDF page counts and keeps unicode filenames', async () => {
        const res = await admin(request(app).post('/api/v1/admin/content'))
            .field('collection', 'curriculum')
            .field('folder', 'primary-4/kinyarwanda')
            .attach('file', await makePdf(3), 'igitabo-cy’umunyeshuri.pdf');
        expect(res.status).toBe(201);
        expect(res.body.item).toMatchObject({ pages: 3, path: 'primary-4/kinyarwanda/igitabo-cy’umunyeshuri.pdf', mime: 'application/pdf' });
    });

    it('rejects path traversal, hidden files and silent overwrites', async () => {
        const send = (fields: Record<string, string>, name = 'x.txt') => {
            let r = admin(request(app).post('/api/v1/admin/content'));
            for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
            return r.attach('file', Buffer.from('x'), name);
        };
        expect((await send({ collection: 'curriculum', folder: '../../etc' })).status).toBe(400);
        expect((await send({ collection: 'curriculum' }, '.env')).status).toBe(400);
        expect((await send({ collection: 'nope' })).status).toBe(400);
        expect((await send({ collection: 'curriculum' }, 'come.txt')).status).toBe(409);
        const ok = await send({ collection: 'curriculum', overwrite: 'true' }, 'come.txt');
        expect(ok.status).toBe(200);
        expect(ok.body.item.version).toBe(2);
    });

    it('keeps admin-edited metadata across rescans', async () => {
        const list = await admin(request(app).get('/api/v1/admin/content').query({ q: 'unit-2' }));
        const item = list.body.items[0];
        const patched = await admin(request(app).patch(`/api/v1/admin/content/${item.id}`)).send({
            title: 'Unit two: fractions',
            categories: ['Maths'],
        });
        expect(patched.body).toMatchObject({ title: 'Unit two: fractions', categories: ['maths'] });

        await fs.writeFile(path.join(indexer.roots.curriculum, item.path), 'two, edited');
        await indexer.reconcile();
        const after = await admin(request(app).get(`/api/v1/admin/content/${item.id}`));
        expect(after.body).toMatchObject({ title: 'Unit two: fractions', version: 2, size: 11 });
    });
});

describe('device sync', () => {
    it('rejects missing or revoked keys', async () => {
        expect((await request(app).get('/api/v1/sync')).status).toBe(401);
        const other = await admin(request(app).post('/api/v1/admin/devices')).send({ name: 'Old box' });
        await admin(request(app).patch(`/api/v1/admin/devices/${other.body.device.id}`)).send({ status: 'revoked' });
        expect((await request(app).get('/api/v1/sync').set('Authorization', `Bearer ${other.body.apiKey}`)).status).toBe(403);
    });

    it('pages through changes and reports updates and deletions after the cursor', async () => {
        const all: any[] = [];
        let since = 0;
        for (;;) {
            const res = await dev(request(app).get('/api/v1/sync').query({ since, limit: 2 }));
            expect(res.status).toBe(200);
            all.push(...res.body.items);
            since = res.body.nextCursor;
            if (!res.body.hasMore) break;
        }
        expect(all.length).toBe(5);
        expect(all.every(i => !i.deleted)).toBe(true);

        await fs.writeFile(path.join(indexer.roots.curriculum, 'primary-4/maths/unit-10.txt'), 'ten, v2');
        await indexer.reconcile();
        const victim = all.find(i => i.path === 'come.txt');
        expect((await admin(request(app).delete(`/api/v1/admin/content/${victim.id}`))).status).toBe(204);

        const delta = await dev(request(app).get('/api/v1/sync').query({ since }));
        expect(delta.body.items).toEqual([
            expect.objectContaining({ path: 'primary-4/maths/unit-10.txt', version: 2, deleted: false }),
            expect.objectContaining({ path: 'come.txt', deleted: true }),
        ]);
        expect((await request(app).get('/metadata')).body.some((n: any) => n.path === 'come.txt')).toBe(false);

        const unchanged = await dev(request(app).get('/api/v1/sync').query({ since: delta.body.nextCursor }));
        expect(unchanged.body).toMatchObject({ items: [], hasMore: false, nextCursor: delta.body.nextCursor });
    });

    it('downloads files by id with hash headers', async () => {
        const list = await admin(request(app).get('/api/v1/admin/content').query({ collection: 'library' }));
        const book = list.body.items[0];
        const res = await dev(request(app).get(`/api/v1/content/${book.id}/file`)).buffer(true);
        expect(res.status).toBe(200);
        expect(res.headers['x-content-sha256']).toBe(book.sha256);
    });
});

describe('device push', () => {
    it('records heartbeats and inventory, flagging outdated copies', async () => {
        const hb = await dev(request(app).post('/api/v1/devices/me/heartbeat')).send({
            softwareVersion: '1.4.0',
            uptimeSeconds: 3600,
            disk: { totalBytes: 500e9, freeBytes: 120e9 },
            connectedClients: 14,
            syncCursor: 7,
        });
        expect(hb.status).toBe(204);

        const items = (await admin(request(app).get('/api/v1/admin/content'))).body.items;
        const unit10 = items.find((i: any) => i.path.endsWith('unit-10.txt'));
        const book = items.find((i: any) => i.collection === 'library');
        const inv = await dev(request(app).put('/api/v1/devices/me/inventory')).send({
            items: [
                { collection: 'curriculum', path: unit10.path, sha256: 'a'.repeat(64) },
                { collection: 'library', contentId: book.id, sha256: book.sha256 },
                { collection: 'curriculum', path: 'local-only/thing.mp4' },
            ],
        });
        expect(inv.body).toEqual({ stored: 3, unknown: 1, outdated: 1 });

        const report = await admin(request(app).get('/api/v1/admin/stats/devices'));
        expect(report.body.find((d: any) => d.id === deviceId)).toMatchObject({
            software_version: '1.4.0',
            installed_items: 3,
            outdated_items: 1,
            disk_free_bytes: 120e9,
        });
    });

    it('accepts usage events idempotently and corrects a wrong device clock', async () => {
        const book = (await admin(request(app).get('/api/v1/admin/content').query({ collection: 'library' }))).body.items[0];
        const now = Date.now();
        const batch = {
            events: [
                { id: 'e1', type: 'view', occurredAt: new Date(now - 60_000).toISOString(), contentId: book.id, learnerRef: 'L1', durationSeconds: 120 },
                { id: 'e2', type: 'view', occurredAt: new Date(now - 30_000).toISOString(), contentId: book.id, learnerRef: 'L2', durationSeconds: 60 },
                { id: 'e3', type: 'video.complete', occurredAt: new Date(now).toISOString(), collection: 'curriculum', path: 'primary-4/maths/unit-10.txt', progress: 1 },
                { id: 'e4', type: 'view', occurredAt: new Date(now).toISOString(), contentId: 999999 },
            ],
        };
        const first = await dev(request(app).post('/api/v1/devices/me/events')).send(batch);
        expect(first.body).toMatchObject({ accepted: 4, duplicates: 0, clockSkewMs: 0 });
        const retry = await dev(request(app).post('/api/v1/devices/me/events')).send(batch);
        expect(retry.body).toMatchObject({ accepted: 0, duplicates: 4 });

        // Box thinks it is 2001; its events should land at the real time.
        const fakeNow = new Date('2001-01-01T00:00:00Z').getTime();
        const skewed = await dev(request(app).post('/api/v1/devices/me/events')).send({
            sentAt: new Date(fakeNow).toISOString(),
            events: [{ id: 'e5', type: 'view', occurredAt: new Date(fakeNow - 1000).toISOString(), contentId: book.id }],
        });
        expect(Math.abs(skewed.body.clockSkewMs - (now - fakeNow))).toBeLessThan(10_000);

        const usage = await admin(request(app).get('/api/v1/admin/stats/usage').query({ groupBy: 'content', type: 'view' }));
        expect(usage.body.rows[0]).toMatchObject({ label: book.title, events: 3, unique_learners: 2, total_duration_seconds: 180 });

        const byCat = await admin(request(app).get('/api/v1/admin/stats/usage').query({ groupBy: 'category' }));
        expect(byCat.body.rows.map((r: any) => r.key).sort()).toEqual(['biology', 'science']);

        const overview = await admin(request(app).get('/api/v1/admin/stats/overview'));
        expect(overview.status).toBe(200);
        expect(overview.body.devices).toMatchObject({ total: 2, active: 1 });
    });

    it('validates event payloads', async () => {
        const bad = await dev(request(app).post('/api/v1/devices/me/events')).send({ events: [{ id: 'x', type: 'View!', occurredAt: 'yesterday' }] });
        expect(bad.status).toBe(400);
        expect(bad.body.issues.length).toBeGreaterThan(0);
    });
});

describe('folder watcher', () => {
    it('indexes files copied in over SFTP and drops removed folders', async () => {
        const watcher = startWatcher(indexer);
        await new Promise<void>(r => watcher.once('ready', () => r()));
        try {
            const dir = path.join(indexer.roots.library, 'Stories');
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, 'tale.epub'), makeEpub('A Tale', 'B. Writer'));

            const book = await waitFor(async () => {
                const res = await request(app).get('/library-metadata');
                return res.body.find((b: any) => b.book_name === 'A Tale');
            });
            expect(book.categories).toBe('stories');

            await fs.rm(dir, { recursive: true });
            await waitFor(async () => {
                const res = await request(app).get('/library-metadata');
                return !res.body.some((b: any) => b.book_name === 'A Tale');
            });
        } finally {
            await watcher.close();
        }
    });
});
