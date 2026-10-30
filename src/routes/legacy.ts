import express, { Router } from 'express';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { contentItems, type ContentItem } from '../db/schema.js';
import { toAbsPath, type CollectionRoots } from '../ingest/paths.js';

/**
 * Endpoints the SomaBox devices already in the field call. Response shapes
 * must stay exactly as the old file-based server produced them; the data now
 * comes from Postgres instead of hand-generated JSON files.
 */

type FileNode = { type: 'file'; name: string; path: string; size: number; id: number; sha256: string; version: number };
type FolderNode = { type: 'folder'; name: string; path: string; children: TreeNode[] };
type TreeNode = FileNode | FolderNode;

// Same display-name rule the old generateMetadata.js used.
const displayName = (segment: string) => segment.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function buildTree(items: Pick<ContentItem, 'id' | 'path' | 'size' | 'sha256' | 'version'>[]): TreeNode[] {
    const root: FolderNode = { type: 'folder', name: '', path: '', children: [] };
    const folders = new Map<string, FolderNode>([['', root]]);

    for (const item of items) {
        const segments = item.path.split('/');
        let parent = root;
        for (let i = 0; i < segments.length - 1; i++) {
            const folderPath = segments.slice(0, i + 1).join('/');
            let folder = folders.get(folderPath);
            if (!folder) {
                folder = { type: 'folder', name: displayName(segments[i]!), path: folderPath, children: [] };
                folders.set(folderPath, folder);
                parent.children.push(folder);
            }
            parent = folder;
        }
        parent.children.push({
            type: 'file',
            name: displayName(segments.at(-1)!),
            path: item.path,
            size: item.size,
            // Additive fields; old devices ignore them.
            id: item.id,
            sha256: item.sha256,
            version: item.version,
        });
    }

    const sort = (nodes: TreeNode[]) => {
        nodes.sort((a, b) => collator.compare(a.path.split('/').at(-1)!, b.path.split('/').at(-1)!));
        for (const n of nodes) if (n.type === 'folder') sort(n.children);
    };
    sort(root.children);
    return root.children;
}

const LIBRARY_FORMATS = ['epub', 'pdf'];

/** "epub,pdf" -> ['epub', 'pdf']; unknown formats are dropped, nothing valid means EPUB only. */
function libraryFormats(raw: unknown): string[] {
    const asked = typeof raw === 'string' ? raw.split(',').map(f => f.trim().toLowerCase()) : [];
    const formats = LIBRARY_FORMATS.filter(f => asked.includes(f));
    return formats.length ? formats : ['epub'];
}

export function legacyRouter(db: Db, roots: CollectionRoots): Router {
    const router = Router();
    const live = (collection: 'curriculum' | 'library') =>
        and(eq(contentItems.collection, collection), isNull(contentItems.deletedAt));

    // Device: GET /metadata -> tree used by "available content" screen.
    router.get('/metadata', async (_req, res) => {
        const items = await db
            .select({
                id: contentItems.id,
                path: contentItems.path,
                size: contentItems.size,
                sha256: contentItems.sha256,
                version: contentItems.version,
            })
            .from(contentItems)
            .where(live('curriculum'))
            .orderBy(asc(contentItems.path));
        res.json(buildTree(items));
    });

    // Device: GET /library-metadata -> [{ id, book_name, categories, extension }].
    // Old devices always save books as "<id>.epub", so only EPUBs are listed by
    // default. Boxes that save by extension ask for more: ?formats=epub,pdf
    router.get('/library-metadata', async (req, res) => {
        const formats = libraryFormats(req.query.formats);
        const books = await db
            .select()
            .from(contentItems)
            .where(and(live('library'), inArray(contentItems.extension, formats)))
            .orderBy(asc(contentItems.title));
        res.json(
            books.map(b => ({
                id: String(b.id),
                book_name: b.title,
                categories: b.categories.join(','),
                author: b.author,
                extension: b.extension,
                size: b.size,
                sha256: b.sha256,
                version: b.version,
            })),
        );
    });

    // Device: GET /content/library/<id>.<ext> (the extension is not checked)
    router.get('/content/library/:file', async (req, res, next) => {
        const id = Number(req.params.file.replace(/\.[a-z0-9]+$/i, ''));
        if (!Number.isSafeInteger(id) || id <= 0) return next();
        const [book] = await db
            .select()
            .from(contentItems)
            .where(and(eq(contentItems.id, id), live('library')));
        if (!book) return next();
        res.sendFile(toAbsPath(roots.library, book.path), { dotfiles: 'deny' });
    });

    // Device: GET/HEAD /content/<url-encoded path> for curriculum files.
    router.use('/content', express.static(roots.curriculum, { index: false, dotfiles: 'ignore', fallthrough: true }));

    return router;
}
