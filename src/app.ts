import cors from 'cors';
import express from 'express';
import { sql } from 'drizzle-orm';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { requireAdmin } from './http/auth.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import type { Indexer } from './ingest/indexer.js';
import { adminRouter } from './routes/admin.js';
import { deviceRouter } from './routes/device.js';
import { legacyRouter } from './routes/legacy.js';

export function createApp({ config, db, indexer }: { config: Config; db: Db; indexer: Indexer }) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback'); // behind nginx on the VPS

    app.use(
        cors({
            origin: config.corsOrigins,
            methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
        }),
    );

    if (config.env !== 'test') {
        app.use((req, res, next) => {
            const start = process.hrtime.bigint();
            res.on('finish', () => {
                const ms = Number(process.hrtime.bigint() - start) / 1e6;
                console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
            });
            next();
        });
    }

    app.get('/api/v1/health', async (_req, res) => {
        try {
            await db.execute(sql`select 1`);
            res.json({ ok: true, db: 'up' });
        } catch {
            res.status(503).json({ ok: false, db: 'down' });
        }
    });

    // Admin uploads are multipart and parse their own body.
    app.use('/api/v1/admin', requireAdmin(config.adminToken), express.json({ limit: '1mb' }), adminRouter(db, indexer, config));
    app.use('/api/v1', express.json({ limit: '10mb' }), deviceRouter(db, indexer.roots));
    app.use(legacyRouter(db, indexer.roots));

    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}
