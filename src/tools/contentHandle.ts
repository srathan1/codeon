import * as crypto from 'crypto';

/**
 * Content handles for large output (PRD §9.7).
 * When tool output exceeds inline limits, store behind a handle and return
 * a reference that can be used to retrieve chunks later.
 */

export interface ContentHandle {
    /** Unique handle ID. */
    id: string;
    /** Total size in bytes. */
    totalBytes: number;
    /** Total number of lines. */
    totalLines: number;
    /** MIME type / content kind. */
    contentType: 'text/plain' | 'text/json' | 'application/octet-stream';
    /** Number of chars returned inline (truncated preview). */
    inlineChars: number;
}

/** In-memory store for content handles. */
const store = new Map<string, {
    content: string;
    handle: ContentHandle;
    createdAt: number;
}>();

/** Max inline output size (chars). Default: 10KB. */
let maxInlineChars = 10_000;

/** Max stored content size (bytes). Default: 5MB. */
let maxStoredBytes = 5 * 1024 * 1024;

/** TTL for stored content (ms). Default: 10 minutes. */
let contentTtlMs = 10 * 60 * 1000;

/**
 * M-8: max number of concurrently held content handles. Previously the
 * store had no bound other than TTL expiry (cleanupExpired only removes
 * entries older than contentTtlMs) — a busy session generating many large
 * tool outputs within one TTL window could grow this map without limit.
 * Oldest entries are evicted once this cap is exceeded (Map preserves
 * insertion order, so this is a simple FIFO/approximate-LRU eviction —
 * good enough here without a separate access-tracking structure).
 */
let maxEntries = 200;

/**
 * Configure content handle limits.
 */
export function configureContentHandles(options?: {
    maxInlineChars?: number;
    maxStoredBytes?: number;
    ttlMs?: number;
    maxEntries?: number;
}): void {
    if (options?.maxInlineChars !== undefined) maxInlineChars = options.maxInlineChars;
    if (options?.maxStoredBytes !== undefined) maxStoredBytes = options.maxStoredBytes;
    if (options?.ttlMs !== undefined) contentTtlMs = options.ttlMs;
    if (options?.maxEntries !== undefined) maxEntries = options.maxEntries;
}

/**
 * Store large content behind a handle. Returns inline preview + handle metadata.
 */
export function storeContent(content: string, contentType: ContentHandle['contentType'] = 'text/plain'): {
    inlineText: string;
    handle: ContentHandle;
} {
    // Clean up expired entries
    cleanupExpired();

    // M-8: evict oldest entries if still over the cap after TTL cleanup.
    while (store.size >= maxEntries) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        store.delete(oldestKey);
    }

    const bytes = Buffer.byteLength(content, 'utf8');

    // Reject oversized content
    if (bytes > maxStoredBytes) {
        throw new Error(`OUTPUT_TRUNCATED: content (${bytes} bytes) exceeds maximum stored size (${maxStoredBytes} bytes)`);
    }

    const lines = content.split('\n');
    const id = 'ch_' + crypto.randomBytes(8).toString('hex');

    const inlineText = content.slice(0, maxInlineChars);
    const handle: ContentHandle = {
        id,
        totalBytes: bytes,
        totalLines: lines.length,
        contentType,
        inlineChars: inlineText.length,
    };

    store.set(id, {
        content,
        handle,
        createdAt: Date.now(),
    });

    return { inlineText, handle };
}

/**
 * Retrieve content by handle ID. Supports pagination via offset/limit.
 */
export function retrieveContent(handleId: string, offset: number = 0, limit: number = maxInlineChars): {
    content: string;
    handle: ContentHandle | null;
    truncated: boolean;
} | null {
    const entry = store.get(handleId);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.createdAt > contentTtlMs) {
        store.delete(handleId);
        return null;
    }

    // L-4: clamp — negative values previously passed straight to .slice(),
    // where a negative offset means "from the end of the string" (not "from
    // the start", which is what this API's offset param is documented to
    // mean), producing unexpected slices instead of an error or a sane default.
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.max(1, limit);
    const slice = entry.content.slice(safeOffset, safeOffset + safeLimit);
    return {
        content: slice,
        handle: entry.handle,
        truncated: (safeOffset + safeLimit) < entry.content.length,
    };
}

/**
 * Retrieve content by line range.
 */
export function retrieveContentByLines(handleId: string, startLine: number, endLine: number): {
    content: string;
    handle: ContentHandle | null;
} | null {
    const entry = store.get(handleId);
    if (!entry) return null;

    if (Date.now() - entry.createdAt > contentTtlMs) {
        store.delete(handleId);
        return null;
    }

    const lines = entry.content.split('\n');
    const slice = lines.slice(startLine, endLine + 1).join('\n');
    return {
        content: slice,
        handle: entry.handle,
    };
}

/**
 * Check if content needs to be stored behind a handle.
 */
export function needsHandle(content: string): boolean {
    return content.length > maxInlineChars;
}

/**
 * Remove a handle from the store.
 */
export function removeHandle(handleId: string): boolean {
    return store.delete(handleId);
}

/**
 * Clean up expired entries.
 */
function cleanupExpired(): void {
    const now = Date.now();
    for (const [id, entry] of store) {
        if (now - entry.createdAt > contentTtlMs) {
            store.delete(id);
        }
    }
}

/**
 * Clear all stored content (e.g., on session end).
 */
export function clearAllHandles(): void {
    store.clear();
}
