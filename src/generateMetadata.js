// After adding new content, run this script to generate metadata
import fs from 'fs';
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONTENT_DIR = path.join(__dirname, '../content/curriculum/rwanda');
const OUTPUT_FILE = path.join(__dirname, 'metadata.json');

function scanFolder(dir, base = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(base, entry.name);
        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
        result.push({
            type: 'folder',
            path: relativePath,
            name: entry.name.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()),
            children: scanFolder(fullPath, relativePath)
        });
        } else {
        const stat = fs.statSync(fullPath);
        result.push({
            type: 'file',
            name: entry.name.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()),
            path: relativePath,
            size: stat.size
        });
        }
    }

    return result;
}

// Generate metadata
const metadata = scanFolder(CONTENT_DIR);

// Write to JSON file
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(metadata, null, 2));
console.log('Metadata generated at', OUTPUT_FILE);
