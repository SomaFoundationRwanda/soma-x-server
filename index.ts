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
const BOOKS_DIR = path.join(__dirname, '../content/books');
const METADATA_FILE = path.join(__dirname, './src/metadata.json');
const BOOKS_METADATA_FILE = path.join(__dirname, './src/books.metadata.json');

// Requesting metadata when a SomaBox user is trying to check available content to sync from the server
app.get('/metadata', (req, res) => {
    console.log("Trying to access metadata")
    try {
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

app.get('/library-metadata', (req, res) => {
    console.log("Trying to access library metadata")
    try {
        console.log("Checking for file:", BOOKS_METADATA_FILE);
        if (!fs.existsSync(BOOKS_METADATA_FILE)) {
            console.log("Library metadata file not found");
            return res.status(404).send('Library metadata not found');
        }
        const metadata = fs.readFileSync(BOOKS_METADATA_FILE);
        console.log("Library metadata found and read");
        res.setHeader('Content-Type', 'application/json');
        res.send(metadata);
    } catch (err) {
        console.error("Error serving library metadata:", err);
        res.status(500).send('Failed to fetch library metadata');
    }
});

// Exposing content for download
console.log("Content Dir:", CONTENT_DIR)
console.log("Books Dir:", BOOKS_DIR)
app.use('/content/library', express.static(BOOKS_DIR));
app.use('/content', express.static(CONTENT_DIR));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
