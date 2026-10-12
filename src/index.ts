import fs from 'node:fs/promises';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { Indexer } from './ingest/indexer.js';
import { startWatcher } from './ingest/watcher.js';

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);

await runMigrations(db);
await fs.mkdir(config.uploadTmpDir, { recursive: true });

const indexer = new Indexer(db, config.collections, config.ffprobePath);
await indexer.ensureRoots();

const app = createApp({ config, db, indexer });
const server = app.listen(config.port, () => {
    console.log(`soma-x-server listening on :${config.port}`);
    for (const [name, dir] of Object.entries(config.collections)) console.log(`  ${name}: ${dir}`);
});

// Watch first so nothing copied during the scan is missed, then catch up on
// anything that changed while the server was down.
const watcher = config.watchContent ? startWatcher(indexer) : null;
indexer
    .reconcile()
    .then(s => console.log('[index] startup scan done', s))
    .catch(err => console.error('[index] startup scan failed', err));

let stopping = false;
async function shutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    server.close();
    await watcher?.close();
    await pool.end();
    process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
