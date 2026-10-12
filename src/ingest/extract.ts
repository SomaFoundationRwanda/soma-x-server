import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import mime from 'mime-types';
import { PDFDocument } from 'pdf-lib';

const execFileAsync = promisify(execFile);

export async function sha256File(abs: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
    return hash.digest('hex');
}

export interface Extracted {
    mime: string | null;
    extension: string;
    title: string | null;
    author: string | null;
    pages: number | null;
    durationSeconds: number | null;
}

/** "grade-5_maths intro.pdf" -> "Grade 5 maths intro" (same idea as the old generator). */
export function titleFromFilename(file: string): string {
    const base = path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : file;
}

// PDFs above this are not parsed for a page count (pdf-lib loads the whole file).
const MAX_PDF_PARSE_BYTES = 300 * 1024 * 1024;

async function pdfPages(abs: string, size: number): Promise<number | null> {
    if (size > MAX_PDF_PARSE_BYTES) return null;
    try {
        const doc = await PDFDocument.load(await fs.readFile(abs), {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        return doc.getPageCount();
    } catch (err) {
        console.warn(`[extract] could not read PDF ${abs}: ${(err as Error).message}`);
        return null;
    }
}

function decodeXml(s: string): string {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, '&')
        .trim();
}

function epubInfo(abs: string): { title: string | null; author: string | null } {
    try {
        const zip = new AdmZip(abs);
        const container = zip.readAsText('META-INF/container.xml');
        const opfPath = container.match(/full-path\s*=\s*"([^"]+)"/)?.[1];
        if (!opfPath) return { title: null, author: null };
        const opf = zip.readAsText(opfPath);
        const pick = (tag: string) => {
            const m = opf.match(new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)</dc:${tag}>`, 'i'));
            return m?.[1] ? decodeXml(m[1]) || null : null;
        };
        return { title: pick('title'), author: pick('creator') };
    } catch (err) {
        console.warn(`[extract] could not read EPUB ${abs}: ${(err as Error).message}`);
        return { title: null, author: null };
    }
}

async function mediaDuration(abs: string, ffprobePath: string): Promise<number | null> {
    try {
        const { stdout } = await execFileAsync(
            ffprobePath,
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs],
            { timeout: 30_000 },
        );
        const seconds = Number.parseFloat(stdout.trim());
        return Number.isFinite(seconds) ? Math.round(seconds) : null;
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') console.warn(`[extract] ffprobe not found at "${ffprobePath}"; durations disabled`);
        else console.warn(`[extract] ffprobe failed for ${abs}: ${e.message}`);
        return null;
    }
}

export async function extractMetadata(abs: string, size: number, ffprobePath: string): Promise<Extracted> {
    const extension = path.extname(abs).slice(1).toLowerCase();
    const type = mime.lookup(abs) || null;
    const out: Extracted = { mime: type, extension, title: null, author: null, pages: null, durationSeconds: null };

    if (extension === 'pdf') {
        out.pages = await pdfPages(abs, size);
    } else if (extension === 'epub') {
        Object.assign(out, epubInfo(abs));
    } else if (type?.startsWith('audio/') || type?.startsWith('video/')) {
        out.durationSeconds = await mediaDuration(abs, ffprobePath);
    }
    return out;
}
