import path from 'node:path';
import { z } from 'zod';

const bool = z
    .enum(['true', 'false', '1', '0'])
    .transform(v => v === 'true' || v === '1');

const schema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(2999),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    // Static token for admin endpoints (uploads, device registration, stats).
    ADMIN_TOKEN: z.string().min(24, 'ADMIN_TOKEN must be at least 24 characters'),
    // Root folder holding all served content. Collections live in sub-folders.
    CONTENT_ROOT: z.string().default('./content'),
    // Where upload temp files go. Must NOT be inside CONTENT_ROOT.
    DATA_DIR: z.string().default('./data'),
    CORS_ORIGINS: z.string().default('*'),
    WATCH_CONTENT: bool.default(true),
    // Path to ffprobe binary for audio/video durations. Missing binary = no durations.
    FFPROBE_PATH: z.string().default('ffprobe'),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(2048),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid configuration:\n${issues}`);
    }
    const c = parsed.data;
    const contentRoot = path.resolve(c.CONTENT_ROOT);
    const dataDir = path.resolve(c.DATA_DIR);
    if (dataDir === contentRoot || dataDir.startsWith(contentRoot + path.sep)) {
        throw new Error('DATA_DIR must not be inside CONTENT_ROOT');
    }
    return {
        env: c.NODE_ENV,
        port: c.PORT,
        databaseUrl: c.DATABASE_URL,
        adminToken: c.ADMIN_TOKEN,
        corsOrigins: c.CORS_ORIGINS === '*' ? '*' : c.CORS_ORIGINS.split(',').map(s => s.trim()),
        watchContent: c.WATCH_CONTENT,
        ffprobePath: c.FFPROBE_PATH,
        maxUploadBytes: Math.floor(c.MAX_UPLOAD_MB * 1024 * 1024),
        contentRoot,
        uploadTmpDir: path.join(dataDir, 'tmp'),
        // Collection name -> folder on disk. Paths match the layout the old
        // server served, so files already on the VPS keep working.
        collections: {
            curriculum: path.join(contentRoot, 'curriculum', 'rwanda'),
            library: path.join(contentRoot, 'books'),
        },
    };
}
