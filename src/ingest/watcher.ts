import { watch, type FSWatcher } from 'chokidar';
import path from 'node:path';
import type { Indexer } from './indexer.js';
import { isIgnoredRelPath, locate } from './paths.js';

/**
 * Watches the collection folders so files copied over SFTP/scp are indexed
 * automatically. Startup reconcile covers anything changed while we were down.
 */
export function startWatcher(indexer: Indexer): FSWatcher {
    const roots = Object.values(indexer.roots);
    const watcher = watch(roots, {
        ignoreInitial: true,
        ignored: (p: string) => {
            const hit = locate(indexer.roots, path.resolve(p));
            return hit ? isIgnoredRelPath(hit.rel) : false;
        },
        // Wait until an upload has stopped growing before hashing it.
        awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
    });

    const run = (what: string, abs: string, fn: (c: 'curriculum' | 'library', rel: string) => Promise<unknown>) => {
        const hit = locate(indexer.roots, path.resolve(abs));
        if (!hit) return;
        fn(hit.collection, hit.rel).catch(err => console.error(`[watch] ${what} ${abs} failed:`, err));
    };

    watcher
        .on('add', p => run('add', p, (c, rel) => indexer.indexFile(c, rel, { source: 'watcher' })))
        .on('change', p => run('change', p, (c, rel) => indexer.indexFile(c, rel, { source: 'watcher' })))
        .on('unlink', p => run('unlink', p, (c, rel) => indexer.markDeleted(c, rel)))
        .on('unlinkDir', p => run('unlinkDir', p, (c, rel) => indexer.markDeletedUnder(c, rel)))
        .on('error', err => console.error('[watch] error', err))
        .on('ready', () => console.log(`[watch] watching ${roots.join(', ')}`));
    return watcher;
}
