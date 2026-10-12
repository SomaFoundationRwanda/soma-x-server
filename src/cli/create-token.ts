// npm run token:create -- --name "staff portal" --scopes read,devices:write,content:write
import { parseArgs } from 'node:util';
import { createDb } from '../db/client.js';
import { API_SCOPES, apiTokens } from '../db/schema.js';
import { generateApiToken } from '../http/auth.js';

const { values } = parseArgs({ options: { name: { type: 'string' }, scopes: { type: 'string' } } });
const scopes = (values.scopes ?? '').split(',').map(s => s.trim()).filter(Boolean);
const unknown = scopes.filter(s => !(API_SCOPES as readonly string[]).includes(s));
if (!values.name || !scopes.length || unknown.length) {
    console.error(`Usage: npm run token:create -- --name "<name>" --scopes ${API_SCOPES.join(',')}`);
    if (unknown.length) console.error(`Unknown scope(s): ${unknown.join(', ')}`);
    process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const { db, pool } = createDb(url);
const t = generateApiToken();
const [row] = await db
    .insert(apiTokens)
    .values({ name: values.name, tokenHash: t.hash, tokenPrefix: t.prefix, scopes })
    .returning();
await pool.end();

console.log(`API token created: ${row!.id} (${row!.name}; scopes: ${scopes.join(', ')})`);
console.log(`Token (shown once):\n\n  ${t.token}\n`);
