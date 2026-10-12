// npm run device:create -- --name "GS Kigali Box 1" [--serial SBX-0001] [--location "Kigali"]
import { parseArgs } from 'node:util';
import { createDb } from '../db/client.js';
import { devices } from '../db/schema.js';
import { generateDeviceKey } from '../http/auth.js';

const { values } = parseArgs({
    options: { name: { type: 'string' }, serial: { type: 'string' }, location: { type: 'string' } },
});
if (!values.name) {
    console.error('Usage: npm run device:create -- --name "<name>" [--serial <serial>] [--location <location>]');
    process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const { db, pool } = createDb(url);
const key = generateDeviceKey();
const [device] = await db
    .insert(devices)
    .values({
        name: values.name,
        serial: values.serial ?? null,
        location: values.location ?? null,
        apiKeyHash: key.hash,
        apiKeyPrefix: key.prefix,
    })
    .returning();
await pool.end();

console.log(`Device created: ${device!.id} (${device!.name})`);
console.log(`API key (shown once, put it in the box's .env as SYNC_TOKEN):\n\n  ${key.key}\n`);
