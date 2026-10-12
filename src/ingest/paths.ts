import path from 'node:path';
import type { Collection } from '../db/schema.js';

export type CollectionRoots = Record<Collection, string>;

// Files we never index: hidden files and partial uploads from SFTP/scp/browsers.
const IGNORED_SUFFIXES = ['.part', '.filepart', '.tmp', '.crdownload', '.download', '~'];

export function isIgnoredName(name: string): boolean {
    if (name.startsWith('.')) return true;
    const lower = name.toLowerCase();
    return IGNORED_SUFFIXES.some(s => lower.endsWith(s));
}

/** Any segment hidden/ignored means the whole path is ignored. */
export function isIgnoredRelPath(rel: string): boolean {
    return rel.split('/').some(seg => seg === '' || isIgnoredName(seg));
}

/**
 * Normalises a user/device-supplied relative path to forward slashes and
 * rejects anything that could escape the collection folder.
 */
export function normalizeRelPath(input: string): string | null {
    const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '').trim();
    if (!cleaned || cleaned.includes('\0')) return null;
    const normalized = path.posix.normalize(cleaned);
    if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return null;
    return normalized.replace(/\/+$/, '');
}

export function toAbsPath(root: string, rel: string): string {
    const abs = path.resolve(root, ...rel.split('/'));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes root: ${rel}`);
    return abs;
}

export function toRelPath(root: string, abs: string): string {
    return path.relative(root, abs).split(path.sep).join('/');
}

/** Finds which collection a path on disk belongs to. */
export function locate(roots: CollectionRoots, abs: string): { collection: Collection; rel: string } | null {
    for (const [collection, root] of Object.entries(roots) as [Collection, string][]) {
        if (abs.startsWith(root + path.sep)) return { collection, rel: toRelPath(root, abs) };
    }
    return null;
}
