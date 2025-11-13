import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 2999;

const CONTENT_DIR = path.join(__dirname, '../content/curriculum/rwanda');
const METADATA_FILE = path.join(__dirname, './src/metadata.json');

// Requesting metadata when a SomaBox user is trying to check available content to sync from the server
app.get('/metadata', (req, res) => {
    console.log("Trying to access metadata")
    try{
        if (!fs.existsSync(METADATA_FILE)) return res.status(404).send('Metadata not found');
        const metadata = fs.readFileSync(METADATA_FILE);
        console.log("Happened")
        res.setHeader('Content-Type', 'application/json');
        res.send(metadata);
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to fetch metadata');
    }
});

// Exposing content for download
console.log(CONTENT_DIR)
app.use('/content', express.static(CONTENT_DIR));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
