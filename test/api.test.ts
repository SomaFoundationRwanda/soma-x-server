import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { Indexer } from '../src/ingest/indexer.js';
import { apiTokens } from '../src/db/schema.js';
import { generateApiToken, hashKey } from '../src/http/auth.js';
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

describe('box sync receiver (somabox-lms outbox)', () => {
    const BOX_ID = randomUUID();
    const device = {
        serialNumber: 'PF3X9K2A',
        machineId: 'abc123',
        macAddresses: [{ interface: 'eth0', mac: '00:11:22:33:44:55', physical: true }],
        hostname: 'somabox',
        model: 'ThinkCentre M720q',
        source: 'script',
    };
    const school = { name: 'GS Kigali', code: 'GSK', province: 'Kigali', district: 'Gasabo', isRural: false };
    const history = [{ startedAt: '2026-10-12T08:00:00Z', finishedAt: '2026-10-12T08:00:01Z', status: 'ok', details: { sent: 3, pending: 0 } }];
    const rec = (entity: string, op: string, entitySyncId: string, data: Record<string, unknown>, occurredAt = new Date().toISOString()) => ({
        syncId: randomUUID(),
        boxId: BOX_ID,
        entity,
        op,
        entitySyncId,
        occurredAt,
        data: { ...data, sync_id: entitySyncId },
    });
    const post = (body: unknown) => dev(request(app).post('/api/v1/box-sync')).send(body as object);

    const learner1 = randomUUID();
    const learner2 = randomUUID();
    const course = randomUUID();

    it('treats an empty batch as a heartbeat and learns the box identity and school', async () => {
        const res = await post({ boxId: BOX_ID, device, school, history, records: [] });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ accepted: 0, duplicates: 0, rejected: 0 });

        const me = await dev(request(app).get('/api/v1/devices/me'));
        expect(me.body).toMatchObject({ boxId: BOX_ID, serial: 'SBX-1', school, hardware: device });
        expect(me.body.syncHistory[0].status).toBe('ok');
    });

    it('stores records once by syncId, so a re-sent batch adds nothing', async () => {
        const batch = {
            boxId: BOX_ID,
            device,
            school,
            history,
            records: [
                rec('users', 'snapshot', learner1, { id: 1, role: 'scholar', grade_level: 'P4', password_hash: 'x' }),
                rec('users', 'insert', learner2, { id: 2, role: 'scholar', grade_level: 'P5' }),
                rec('users', 'insert', randomUUID(), { id: 3, role: 'teacher' }),
                rec('courses', 'insert', course, { id: 'C001', title: 'Maths P4', created_by_teacher_person: randomUUID() }),
            ],
        };
        expect((await post(batch)).body).toEqual({ accepted: 4, duplicates: 0, rejected: 0 });
        expect((await post(batch)).body).toEqual({ accepted: 0, duplicates: 4, rejected: 0 });

        const raw = await admin(request(app).get('/api/v1/admin/records').query({ entity: 'users' }));
        expect(raw.body.records).toHaveLength(3);
        expect(raw.body.records.every((r: any) => !('password_hash' in r.data))).toBe(true);
    });

    it('drops only malformed records instead of stalling the box', async () => {
        const res = await post({
            boxId: BOX_ID,
            records: [{ syncId: 'not-a-uuid', entity: 'users', op: 'insert' }, rec('courses', 'update', course, { id: 'C001', title: 'Mathematics P4' })],
        });
        expect(res.body).toEqual({ accepted: 1, duplicates: 0, rejected: 1 });
    });

    it('reports current state: updates replace, deletes remove', async () => {
        await post({ boxId: BOX_ID, records: [rec('users', 'delete', learner2, { id: 2, role: 'scholar' })] });

        const courses = await admin(request(app).get('/api/v1/admin/records/current').query({ entity: 'courses' }));
        expect(courses.body).toHaveLength(1);
        expect(courses.body[0].data.title).toBe('Mathematics P4');

        const report = await admin(request(app).get('/api/v1/admin/stats/devices'));
        expect(report.body.find((d: any) => d.id === deviceId)).toMatchObject({
            school_name: 'GS Kigali',
            district: 'Gasabo',
            model: 'ThinkCentre M720q',
            last_run_status: 'ok',
            pending_records: 0,
            learners: 1,
            teachers: 1,
            courses: 1,
        });
        const schools = await admin(request(app).get('/api/v1/admin/stats/schools'));
        expect(schools.body).toEqual([expect.objectContaining({ school_name: 'GS Kigali', boxes: 1, learners: 1, teachers: 1 })]);
    });

    it('aggregates usage events by type, course, district and catalogue item', async () => {
        const book = (await admin(request(app).get('/api/v1/admin/content').query({ collection: 'library' }))).body.items[0];
        const ev = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
            const id = randomUUID();
            return rec('usage_events', 'insert', id, { event_type: type, role: 'scholar', created_at: new Date().toISOString(), data, ...extra });
        };
        await post({
            boxId: BOX_ID,
            records: [
                ev('course_opened', {}, { user_id: 1, course_id: 'C001' }),
                ev('course_opened', {}, { user_id: 3, course_id: 'C001' }),
                ev('item_opened', {}, { user_id: 1, course_id: 'C001' }),
                ev('content_opened', { source: 'library', cloudContentId: book.id, title: book.title }, { user_id: 1 }),
                ev('content_opened', { source: 'library', cloudContentId: book.id, title: book.title }, { user_id: 3 }),
                ev('content_opened', { source: 'rwandan-education', path: 'science/cells.mp4', title: 'Cells' }, { user_id: 1 }),
            ],
        });

        const byType = await admin(request(app).get('/api/v1/admin/stats/usage').query({ groupBy: 'type' }));
        expect(byType.body.rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ key: 'course_opened', events: 2, unique_people: 2 }),
                expect.objectContaining({ key: 'content_opened', events: 3, unique_people: 2 }),
            ]),
        );
        const byCourse = await admin(request(app).get('/api/v1/admin/stats/usage').query({ groupBy: 'course' }));
        expect(byCourse.body.rows).toEqual([expect.objectContaining({ label: 'Mathematics P4', events: 3, unique_people: 2 })]);

        const byDistrict = await admin(request(app).get('/api/v1/admin/stats/usage').query({ groupBy: 'district' }));
        expect(byDistrict.body.rows).toEqual([expect.objectContaining({ key: 'Gasabo', events: 6, unique_devices: 1 })]);

        const byContent = await admin(request(app).get('/api/v1/admin/stats/usage').query({ groupBy: 'content' }));
        expect(byContent.body.rows).toEqual([
            expect.objectContaining({ key: String(book.id), label: book.title, events: 2 }),
            expect.objectContaining({ label: 'Cells', events: 1 }),
        ]);
        const reach = await admin(request(app).get(`/api/v1/admin/stats/content/${book.id}`));
        expect(reach.body.usage).toEqual([expect.objectContaining({ type: 'content_opened', events: 2, unique_people: 2 })]);

        const overview = await admin(request(app).get('/api/v1/admin/stats/overview'));
        expect(overview.body.devices).toMatchObject({ total: 2, active: 1, schools: 1 });
        expect(overview.body.people).toEqual(expect.arrayContaining([{ role: 'scholar', people: 1 }, { role: 'teacher', people: 1 }]));
    });

    it('lists learners with their profile, enrolments and performance, and computes shares', async () => {
        const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
        const done = '2026-10-01T09:00:00Z';
        const profile = (id: number, extra: Record<string, unknown>) => ({ id, role: 'scholar', grade_level: 'P4', created_at: done, ...extra });
        const r = (entity: string, data: Record<string, unknown>) => rec(entity, 'insert', randomUUID(), data);
        await post({
            boxId: BOX_ID,
            records: [
                rec('users', 'snapshot', a, profile(10, { learner_code: 'GSK-0010', gender: 'female', is_rural: 1, disability_status: 'visual',
                    region_province: 'Eastern', region_district: 'Bugesera', preferred_language: 'rw', profile_completed_at: done })),
                rec('users', 'snapshot', b, profile(11, { learner_code: 'GSK-0011', gender: 'male', is_rural: 0, disability_status: 'none',
                    region_district: 'Not Specified', preferred_language: 'en', profile_completed_at: done })),
                // Never completed the profile: the defaults (urban, no disability) are not answers.
                rec('users', 'snapshot', c, profile(12, { learner_code: 'GSK-0012', gender: 'female', is_rural: 0, disability_status: 'none', profile_completed_at: null })),
                r('enrollments', { course_id: 'C001', role: 'student', status: 'active', user_person: a }),
                r('enrollments', { course_id: 'C001', role: 'student', status: 'active', user_person: b }),
                r('enrollments', { course_id: 'C001', role: 'teacher', status: 'active', user_person: randomUUID() }),
                r('quiz_attempts', { quiz_id: 5, user_id: 10, attempt_number: 1, score_pct: 60, submitted_at: '2026-10-02T10:00:00Z' }),
                r('quiz_attempts', { quiz_id: 5, user_id: 10, attempt_number: 2, score_pct: 80, submitted_at: '2026-10-03T10:00:00Z' }),
                r('quiz_attempts', { quiz_id: 6, user_id: 10, attempt_number: 1, score_pct: 90, submitted_at: '2026-10-04T10:00:00Z' }),
                r('quiz_attempts', { quiz_id: 7, user_id: 10, attempt_number: 1, score_pct: null, submitted_at: null }), // still in progress
                r('quiz_attempts', { quiz_id: 5, user_id: 11, attempt_number: 1, score_pct: 50, submitted_at: '2026-10-02T10:00:00Z' }),
                r('outcome_results', { user_id: 10, course_id: 'C001', outcome_id: 1, pct: 40, assessed_at: '2026-10-02T10:00:00Z' }),
                r('outcome_results', { user_id: 10, course_id: 'C001', outcome_id: 1, pct: 70, assessed_at: '2026-10-05T10:00:00Z' }),
                r('outcome_results', { user_id: 10, course_id: 'C001', outcome_id: 2, pct: 90, assessed_at: '2026-10-05T10:00:00Z' }),
            ],
        });

        const list = async (query: Record<string, string> = {}) => (await admin(request(app).get('/api/v1/admin/stats/learners').query(query))).body;
        const all = await list();
        expect(all.total).toBe(4); // learner 1 (synced before profiles were sent) and the three above
        const first = all.learners.find((l: any) => l.learner_code === 'GSK-0010');
        expect(first).toMatchObject({
            sync_id: a, school_name: 'GS Kigali', grade: 'P4', gender: 'female', rural: 'rural', disability: 'visual',
            province: 'Eastern', district: 'Bugesera', language: 'rw', profile_complete: true,
            courses: 1, quizzes: 2, quiz_avg: 85, mastery_avg: 80,
        });
        expect(first.last_active).toBeTruthy();
        expect(all.learners.find((l: any) => l.learner_code === 'GSK-0011')).toMatchObject({ rural: 'urban', disability: 'none', district: null, quiz_avg: 50, mastery_avg: null });
        expect(all.learners.find((l: any) => l.learner_code === 'GSK-0012')).toMatchObject({ gender: 'female', rural: null, disability: null, courses: 0 });
        expect(all.learners.find((l: any) => l.learner_code === '#1')).toMatchObject({ gender: null, rural: null, disability: null });

        expect((await list({ gender: 'female' })).total).toBe(2);
        expect((await list({ rural: 'rural' })).learners.map((l: any) => l.learner_code)).toEqual(['GSK-0010']);
        expect((await list({ disability: 'any' })).learners.map((l: any) => l.learner_code)).toEqual(['GSK-0010']);
        expect((await list({ disability: 'unknown' })).total).toBe(2);
        expect((await list({ q: 'gsk-0011' })).learners.map((l: any) => l.learner_code)).toEqual(['GSK-0011']);
        expect((await list({ limit: '1', offset: '1' })).learners).toHaveLength(1);

        const detail = await admin(request(app).get(`/api/v1/admin/stats/learners/${deviceId}/${a}`));
        expect(detail.body).toMatchObject({ learner_code: 'GSK-0010', quiz_avg: 85 });
        expect(detail.body.enrolments).toEqual([{ course_id: 'C001', title: 'Mathematics P4', status: 'active', mastery_avg: 80, outcomes_assessed: 2 }]);
        expect(detail.body.quizzes).toBe(2);
        expect(detail.body.quiz_results.map((q: any) => [q.quiz_id, q.best_pct])).toEqual([['6', 90], ['5', 80]]);
        expect((await admin(request(app).get(`/api/v1/admin/stats/learners/${deviceId}/${randomUUID()}`))).status).toBe(404);

        const stats = (await admin(request(app).get('/api/v1/admin/stats/demographics'))).body;
        expect(stats).toMatchObject({ learners: 4, profiles_complete: 2, enrolled: 2, boxes: 1, schools: 1 });
        // Shares are of learners whose answer is known.
        expect(stats.headline).toEqual({ girlsPct: 66.7, ruralPct: 50, disabilityPct: 50, profilesCompletePct: 50 });
        expect(stats.gender).toMatchObject({ known: 3, unknown: 1 });
        expect(stats.gender.groups).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'female', learners: 2, quiz_avg: 85, mastery_avg: 80, share: 66.7 }),
            expect.objectContaining({ key: 'male', learners: 1, quiz_avg: 50, mastery_avg: null, share: 33.3 }),
        ]));
        expect(stats.district.groups).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'Gasabo', learners: 3, girlsPct: 50, ruralPct: 0 }), // their school's district
            expect.objectContaining({ key: 'Bugesera', learners: 1, girlsPct: 100, ruralPct: 100, disabilityPct: 100 }),
        ]));
        expect(stats.box.groups).toEqual([expect.objectContaining({ key: deviceId, label: 'Test box', learners: 4, girlsPct: 66.7 })]);
        expect((await admin(request(app).get('/api/v1/admin/stats/demographics').query({ gender: 'female' }))).body.learners).toBe(2);
    });

    it('needs the box key', async () => {
        expect((await request(app).post('/api/v1/box-sync').send({ records: [] })).status).toBe(401);
    });
});

describe('scoped API tokens (e.g. the staff portal)', () => {
    async function token(scopes: string[]) {
        const t = generateApiToken();
        await ctx.db.insert(apiTokens).values({ name: `test ${scopes.join('+')}`, tokenHash: t.hash, tokenPrefix: t.prefix, scopes });
        return t.token;
    }

    it('limits each token to its scopes', async () => {
        const reader = await token(['read']);
        const as = (t: string) => (r: request.Test) => r.set('Authorization', `Bearer ${t}`);
        expect((await as(reader)(request(app).get('/api/v1/admin/stats/devices'))).status).toBe(200);
        const denied = await as(reader)(request(app).post('/api/v1/admin/devices')).send({ name: 'x' });
        expect(denied.status).toBe(403);
        expect(denied.body.error).toContain('devices:write');

        const fleet = await token(['read', 'devices:write']);
        expect((await as(fleet)(request(app).post('/api/v1/admin/devices')).send({ name: 'Portal box' })).status).toBe(201);
        expect((await as(fleet)(request(app).post('/api/v1/admin/reindex'))).status).toBe(403);
        expect((await request(app).get('/api/v1/admin/stats/devices').set('Authorization', 'Bearer sxa_nope')).status).toBe(401);
    });

    it('records who changed what, including the person the portal acted for', async () => {
        const t = await token(['read', 'devices:write']);
        await request(app).post('/api/v1/admin/devices').set('Authorization', `Bearer ${t}`).set('X-Actor', 'se@sfr.org').send({ name: 'Audited box' });
        await request(app).get('/api/v1/admin/devices').set('Authorization', `Bearer ${t}`); // reads aren't audited
        const audit = await admin(request(app).get('/api/v1/admin/audit'));
        expect(audit.body[0]).toMatchObject({ tokenName: 'test read+devices:write', actor: 'se@sfr.org', method: 'POST', path: '/api/v1/admin/devices', status: 201 });
        expect(audit.body.some((a: any) => a.method === 'GET')).toBe(false);
    });

    it('stops working once revoked', async () => {
        const t = await token(['read']);
        await ctx.db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.tokenHash, hashKey(t)));
        expect((await request(app).get('/api/v1/admin/devices').set('Authorization', `Bearer ${t}`)).status).toBe(401);
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
