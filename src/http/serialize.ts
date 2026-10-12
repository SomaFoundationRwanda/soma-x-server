import type { ContentItem, Device } from '../db/schema.js';

export function contentToApi(item: ContentItem) {
    return {
        id: item.id,
        collection: item.collection,
        path: item.path,
        title: item.title,
        author: item.author,
        description: item.description,
        categories: item.categories,
        mime: item.mime,
        extension: item.extension,
        size: item.size,
        sha256: item.sha256,
        pages: item.pages,
        durationSeconds: item.durationSeconds,
        version: item.version,
        changeSeq: item.changeSeq,
        updatedAt: item.updatedAt,
        deleted: item.deletedAt !== null,
        downloadUrl: `/api/v1/content/${item.id}/file`,
    };
}

export function deviceToApi(d: Device) {
    return {
        id: d.id,
        name: d.name,
        serial: d.serial,
        location: d.location,
        notes: d.notes,
        status: d.status,
        apiKeyPrefix: d.apiKeyPrefix,
        boxId: d.boxId,
        school: d.school,
        hardware: d.hardware,
        syncHistory: d.syncHistory,
        lastSeenAt: d.lastSeenAt,
        lastIp: d.lastIp,
        lastSyncAt: d.lastSyncAt,
        createdAt: d.createdAt,
    };
}
