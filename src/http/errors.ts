import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { z, ZodError } from 'zod';

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
    }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);

export const idParam = z.coerce.number().int().positive();

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound());

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (res.headersSent) return;
    if (err instanceof ZodError) {
        res.status(400).json({
            error: 'Invalid request',
            issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
    }
    if (err instanceof multer.MulterError) {
        res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
        return;
    }
    if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
        return;
    }
    // body-parser errors (bad JSON, too large) carry a status.
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(`[http] ${req.method} ${req.originalUrl}`, err);
    res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
};
