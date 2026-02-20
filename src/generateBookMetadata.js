const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const ffprobe = require('ffprobe');
const ffprobeStatic = require('ffprobe-static');
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONTENT_DIR = path.join(__dirname, '../content');
const OUTPUT_FILE = path.join(__dirname, 'content-data.json');

let idCounter = 1;
const jsonData = {}; // top-level flat JSON

// Get number of pages in a PDF
async function getPdfPages(filePath) {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdf(dataBuffer);
    return data.numpages;
  } catch (err) {
    console.warn(`Warning: Could not read PDF ${filePath}: ${err.message}`);
    return null;
  }
}

// Get duration of audio/video in minutes
async function getMediaDuration(filePath) {
  try {
    const info = await ffprobe(filePath, { path: ffprobeStatic.path });
    const durationSec = info.streams[0]?.duration || info.format?.duration;
    return durationSec ? Math.ceil(durationSec / 60) + ' min' : null;
  } catch (err) {
    console.warn(`Warning: Could not read media ${filePath}: ${err.message}`);
    return null;
  }
}

// Create content object
async function createContentObject(filePath, type) {
  const ext = path.extname(filePath).toLowerCase();
  const obj = {
    id: idCounter++,
    title: path.basename(filePath, ext),
    type,
    thumbnail: '/images/default.jpg',
    url: '/content/' + path.relative(CONTENT_DIR, filePath).replace(/\\/g, '/'),
    description: 'Description for ' + path.basename(filePath, ext)
  };

  if (type === 'book') obj.pages = await getPdfPages(filePath);
  else obj.duration = await getMediaDuration(filePath);

  return obj;
}

// Process a folder to generate its JSON entry
async function processFolder(folderPath, slug) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const folderObj = {
    title: slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
    subtitle: '',
    isContentLevel: false,
    content: [],
    items: []
  };

  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      // Assume folder types: audio/video/book -> leaf content
      if (['audio', 'video', 'book'].includes(entry.name.toLowerCase())) {
        const files = fs.readdirSync(fullPath);
        for (const file of files) {
          const filePath = path.join(fullPath, file);
          folderObj.content.push(await createContentObject(filePath, entry.name.toLowerCase()));
        }
        if (files.length > 0) folderObj.isContentLevel = true;
      } else {
        // Subfolder: create item entry for parent and process separately
        const childSlug = entry.name.toLowerCase().replace(/\s+/g, '-');
        folderObj.items.push({
          title: entry.name,
          slug: childSlug,
          image: '/images/default.jpg',
          colorClass: 'bg-gray-400'
        });
        await processFolder(fullPath, childSlug); // recursive, adds to top-level
      }
    }
  }

  jsonData[slug] = folderObj;
}

// Main function
(async () => {
  const topFolders = fs.readdirSync(CONTENT_DIR, { withFileTypes: true }).filter(f => f.isDirectory());

  for (const folder of topFolders) {
    const slug = folder.name.toLowerCase().replace(/\s+/g, '-');
    const folderPath = path.join(CONTENT_DIR, folder.name);
    await processFolder(folderPath, slug);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(jsonData, null, 2));
  console.log('Content JSON generated at', OUTPUT_FILE);
})();
