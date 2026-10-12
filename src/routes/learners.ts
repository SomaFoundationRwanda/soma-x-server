import { Router } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { HttpError } from '../http/errors.js';
import { currentRecords } from './stats.js';

/**
 * Learners as boxes sync them (pseudonymous: a learner code and profile answers, never names,
 * emails or phones), with what they're enrolled in and how they perform, for lists and statistics
 * (share of girls, rural learners, learners with a disability...).
 *
 * Profile answers the box stores as defaults ("prefer_not_to_say", "Not Specified", urban, no
 * disability) can't be told apart from real answers, so a value counts as known only when it is a
 * real answer, or when the learner completed their profile (profile_completed_at).
 */

const filters = z.object({
    deviceId: z.uuid().optional(),
    school: z.string().max(200).optional(),
    district: z.string().max(200).optional(),
    grade: z.string().max(50).optional(),
    gender: z.enum(['female', 'male', 'other', 'unknown']).optional(),
    rural: z.enum(['rural', 'urban', 'unknown']).optional(),
    disability: z.enum(['any', 'none', 'unknown', 'visual', 'hearing', 'mobility', 'cognitive', 'other']).optional(),
    language: z.string().max(50).optional(),
    q: z.string().trim().max(100).optional(),
});

const listQuery = filters.extend({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
});

// Normalised profile fields, from a users record `u` (with `completed` = profile completed).
const completed = sql`(u.data->>'profile_completed_at') IS NOT NULL`;
const gender = sql`CASE WHEN u.data->>'gender' IN ('female', 'male', 'other') THEN u.data->>'gender' END`;
const disability = sql`CASE
    WHEN u.data->>'disability_status' IN ('visual', 'hearing', 'mobility', 'cognitive', 'other') THEN u.data->>'disability_status'
    WHEN u.data->>'disability_status' = 'none' AND ${completed} THEN 'none' END`;
const rural = sql`CASE
    WHEN (u.data->>'is_rural') IN ('1', 'true') THEN 'rural'
    WHEN (u.data->>'is_rural') IN ('0', 'false') AND ${completed} THEN 'urban' END`;
const known = (col: string) => sql`nullif(nullif(trim(u.data->>${col}), ''), 'Not Specified')`;

/**
 * One row per learner (current state, deletes excluded) with the profile normalised, the box and
 * school, and aggregates of their enrolments, quiz scores, outcome mastery and last activity.
 */
function learnersCte(f: z.output<typeof filters>): SQL {
    const where: SQL[] = [sql`u.data->>'role' = 'scholar'`];
    if (f.deviceId) where.push(sql`u.device_id = ${f.deviceId}`);
    if (f.school) where.push(sql`d.school->>'name' = ${f.school}`);
    if (f.district) where.push(sql`coalesce(${known('region_district')}, d.school->>'district') = ${f.district}`);
    if (f.grade) where.push(sql`u.data->>'grade_level' = ${f.grade}`);
    if (f.gender) where.push(f.gender === 'unknown' ? sql`${gender} IS NULL` : sql`${gender} = ${f.gender}`);
    if (f.rural) where.push(f.rural === 'unknown' ? sql`${rural} IS NULL` : sql`${rural} = ${f.rural}`);
    if (f.disability === 'any') where.push(sql`${disability} NOT IN ('none')`);
    else if (f.disability === 'unknown') where.push(sql`${disability} IS NULL`);
    else if (f.disability) where.push(sql`${disability} = ${f.disability}`);
    if (f.language) where.push(sql`lower(u.data->>'preferred_language') = lower(${f.language})`);
    if (f.q) where.push(sql`(u.data->>'learner_code' ILIKE ${'%' + f.q + '%'} OR u.data->>'id' = ${f.q})`);

    return sql`
        learners AS (
            SELECT u.device_id, u.entity_sync_id AS sync_id, u.data->>'id' AS box_user_id, u.data->>'email' AS email,
                   d.name AS device_name, d.school->>'name' AS school_name, d.school->>'district' AS school_district,
                   d.school->>'province' AS school_province,
                   u.data->>'learner_code' AS learner_code,
                   u.data->>'grade_level' AS grade,
                   ${gender} AS gender, ${disability} AS disability, ${rural} AS rural,
                   ${known('region_province')} AS province, ${known('region_district')} AS district,
                   nullif(trim(u.data->>'preferred_language'), '') AS language,
                   ${completed} AS profile_complete,
                   coalesce((u.data->>'is_active') NOT IN ('0', 'false'), true) AS active,
                   (u.data->>'created_at')::timestamptz AS joined_at
            FROM ${currentRecords('users')} u
            JOIN devices d ON d.id = u.device_id
            WHERE ${sql.join(where, sql` AND `)}
        ),
        enrolled AS (
            SELECT l.device_id, l.sync_id, e.data->>'course_id' AS course_id, e.data->>'status' AS status
            FROM learners l
            JOIN ${currentRecords('enrollments')} e ON e.device_id = l.device_id
             AND coalesce(e.data->>'role', 'student') = 'student'
             AND (e.data->>'user_person' = l.sync_id::text OR (l.email IS NOT NULL AND e.data->>'user_email' = l.email))
        ),
        -- Best attempt per quiz, then averaged.
        quiz_best AS (
            SELECT l.device_id, l.sync_id, qa.data->>'quiz_id' AS quiz_id, max((qa.data->>'score_pct')::numeric) AS pct,
                   max((qa.data->>'submitted_at')::timestamptz) AS last_at
            FROM learners l
            JOIN ${currentRecords('quiz_attempts')} qa ON qa.device_id = l.device_id AND qa.data->>'user_id' = l.box_user_id
            WHERE qa.data->>'submitted_at' IS NOT NULL AND qa.data->>'score_pct' IS NOT NULL
            GROUP BY 1, 2, 3
        ),
        -- Latest evidence per outcome, then averaged (per course and overall).
        mastery AS (
            SELECT DISTINCT ON (l.device_id, l.sync_id, o.data->>'outcome_id')
                   l.device_id, l.sync_id, o.data->>'course_id' AS course_id, (o.data->>'pct')::numeric AS pct,
                   (o.data->>'assessed_at')::timestamptz AS last_at
            FROM learners l
            JOIN ${currentRecords('outcome_results')} o ON o.device_id = l.device_id AND o.data->>'user_id' = l.box_user_id
            ORDER BY l.device_id, l.sync_id, o.data->>'outcome_id', (o.data->>'assessed_at')::timestamptz DESC
        ),
        seen AS (
            SELECT l.device_id, l.sync_id, max(coalesce((ue.data->>'created_at')::timestamptz, ue.occurred_at)) AS last_at
            FROM learners l
            JOIN ${currentRecords('usage_events')} ue ON ue.device_id = l.device_id AND ue.data->>'user_id' = l.box_user_id
            GROUP BY 1, 2
        ),
        summary AS (
            SELECT l.*,
                   (SELECT count(*) FROM enrolled e WHERE e.device_id = l.device_id AND e.sync_id = l.sync_id)::int AS courses,
                   (SELECT count(*) FROM quiz_best q WHERE q.device_id = l.device_id AND q.sync_id = l.sync_id)::int AS quizzes,
                   (SELECT round(avg(q.pct), 1) FROM quiz_best q WHERE q.device_id = l.device_id AND q.sync_id = l.sync_id)::float AS quiz_avg,
                   (SELECT round(avg(m.pct), 1) FROM mastery m WHERE m.device_id = l.device_id AND m.sync_id = l.sync_id)::float AS mastery_avg,
                   greatest(
                       (SELECT s.last_at FROM seen s WHERE s.device_id = l.device_id AND s.sync_id = l.sync_id),
                       (SELECT max(q.last_at) FROM quiz_best q WHERE q.device_id = l.device_id AND q.sync_id = l.sync_id),
                       (SELECT max(m.last_at) FROM mastery m WHERE m.device_id = l.device_id AND m.sync_id = l.sync_id)
                   ) AS last_active
            FROM learners l
        )`;
}

const learnerColumns = sql`
    s.device_id, s.device_name, s.sync_id, coalesce(s.learner_code, '#' || s.box_user_id) AS learner_code,
    s.school_name, s.school_district, s.school_province, s.grade, s.gender, s.disability, s.rural,
    s.province, s.district, s.language, s.profile_complete, s.active, s.joined_at,
    s.courses, s.quizzes, s.quiz_avg, s.mastery_avg, s.last_active`;

/** Share of `part` in `whole`, as a percentage with one decimal; null when nothing is known. */
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export function learnersRouter(db: Db): Router {
    const router = Router();

    /** ?deviceId=&school=&district=&grade=&gender=&rural=&disability=&language=&q=&limit=&offset= */
    router.get('/learners', async (req, res) => {
        const q = listQuery.parse(req.query);
        const result = await db.execute(sql`
            WITH ${learnersCte(q)}
            SELECT ${learnerColumns}, count(*) OVER ()::int AS total
            FROM summary s
            ORDER BY s.school_name NULLS LAST, s.learner_code NULLS LAST, s.box_user_id
            LIMIT ${q.limit} OFFSET ${q.offset}`);
        const rows = result.rows.map(({ total, ...r }) => r);
        res.json({ total: (result.rows[0]?.total as number | undefined) ?? 0, limit: q.limit, offset: q.offset, learners: rows });
    });

    /** One learner: profile, each course with its mastery, and recent quiz results. */
    router.get('/learners/:deviceId/:syncId', async (req, res) => {
        const deviceId = z.uuid().parse(req.params.deviceId);
        const syncId = z.uuid().parse(req.params.syncId);
        const base = learnersCte({ deviceId });
        const [learner, courses, quizzes] = await Promise.all([
            db.execute(sql`WITH ${base} SELECT ${learnerColumns} FROM summary s WHERE s.sync_id = ${syncId}`),
            db.execute(sql`
                WITH ${base}
                SELECT e.course_id, coalesce(c.data->>'title', e.course_id) AS title, e.status,
                       round(avg(m.pct), 1)::float AS mastery_avg, count(m.pct)::int AS outcomes_assessed
                FROM enrolled e
                LEFT JOIN ${currentRecords('courses')} c ON c.device_id = e.device_id AND c.data->>'id' = e.course_id
                LEFT JOIN mastery m ON m.device_id = e.device_id AND m.sync_id = e.sync_id AND m.course_id = e.course_id
                WHERE e.sync_id = ${syncId}
                GROUP BY 1, 2, 3 ORDER BY 2`),
            db.execute(sql`
                WITH ${base}
                SELECT quiz_id, round(pct, 1)::float AS best_pct, last_at AS submitted_at
                FROM quiz_best WHERE sync_id = ${syncId}
                ORDER BY last_at DESC NULLS LAST LIMIT 50`),
        ]);
        if (!learner.rows[0]) throw new HttpError(404, 'Learner not found');
        res.json({ ...learner.rows[0], enrolments: courses.rows, quizzes: quizzes.rows });
    });

    /**
     * Statistics for presentations: counts and shares (of learners whose answer is known) by
     * gender, rural/urban, disability, language, grade and district, plus average performance
     * per group. Same filters as /learners.
     */
    router.get('/demographics', async (req, res) => {
        const f = filters.parse(req.query);
        const base = learnersCte(f);
        const groups = ['gender', 'rural', 'disability', 'language', 'grade', 'district'] as const;
        const [totals, ...breakdowns] = await Promise.all([
            db.execute(sql`
                WITH ${base}
                SELECT count(*)::int AS learners,
                       count(*) FILTER (WHERE profile_complete)::int AS profiles_complete,
                       count(*) FILTER (WHERE courses > 0)::int AS enrolled,
                       round(avg(quiz_avg)::numeric, 1)::float AS quiz_avg,
                       round(avg(mastery_avg)::numeric, 1)::float AS mastery_avg,
                       count(DISTINCT device_id)::int AS boxes,
                       count(DISTINCT school_name)::int AS schools
                FROM summary`),
            ...groups.map(g => {
                // Districts: the learner's own answer, else their school's.
                const key = g === 'district' ? sql`coalesce(district, school_district)` : sql.raw(g);
                return db.execute(sql`
                    WITH ${base}
                    SELECT ${key} AS key, count(*)::int AS learners,
                           round(avg(quiz_avg)::numeric, 1)::float AS quiz_avg, round(avg(mastery_avg)::numeric, 1)::float AS mastery_avg
                    FROM summary GROUP BY 1 ORDER BY learners DESC`);
            }),
        ]);

        const t = totals.rows[0] as { learners: number } & Record<string, unknown>;
        const out: Record<string, unknown> = { ...t };
        groups.forEach((g, i) => {
            const rows = breakdowns[i]!.rows as { key: string | null; learners: number; quiz_avg: number | null; mastery_avg: number | null }[];
            const knownTotal = rows.filter(r => r.key !== null).reduce((n, r) => n + r.learners, 0);
            out[g] = {
                known: knownTotal,
                unknown: rows.find(r => r.key === null)?.learners ?? 0,
                groups: rows
                    .filter(r => r.key !== null)
                    .map(r => ({ ...r, share: pct(r.learners, knownTotal) })),
            };
        });
        // The headline shares, of learners whose answer is known.
        const share = (g: string, keys: string[]) => {
            const b = out[g] as { known: number; groups: { key: string; learners: number }[] };
            return pct(b.groups.filter(r => keys.includes(r.key)).reduce((n, r) => n + r.learners, 0), b.known);
        };
        out.headline = {
            girlsPct: share('gender', ['female']),
            ruralPct: share('rural', ['rural']),
            disabilityPct: share('disability', ['visual', 'hearing', 'mobility', 'cognitive', 'other']),
            profilesCompletePct: pct(Number(t.profiles_complete), t.learners),
        };
        res.json(out);
    });

    return router;
}
