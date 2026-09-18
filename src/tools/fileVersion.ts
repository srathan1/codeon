import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * File version tracking for stale edit detection (PRD §9.2).
 * Every read returns a version token; every write requires one.
 */

/**
 * Compute a stable content hash for a file.
 */
export function hashContent(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Get a version token for an existing file (hash + mtime).
 */
export function getFileVersion(filePath: string): { version: string; mtime: number; size: number } | null {
    try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        return {
            version: hashContent(content),
            mtime: stat.mtimeMs,
            size: stat.size,
        };
    } catch {
        return null;
    }
}

/**
 * Check if a file has been modified since the agent last read it.
 */
export function checkFileStale(
    filePath: string,
    expectedVersion?: string,
    expectedMtime?: number,
): { stale: boolean; reason?: string; currentVersion?: string } {
    try {
        const stat = fs.statSync(filePath);

        // Check mtime first (cheap)
        if (expectedMtime !== undefined && stat.mtimeMs !== expectedMtime) {
            const currentVersion = hashContent(fs.readFileSync(filePath, 'utf8'));
            return {
                stale: true,
                reason: `STALE_FILE_VERSION: file modified since last read (current version: ${currentVersion.slice(0, 8)}...)`,
                currentVersion,
            };
        }

        // Check content hash
        if (expectedVersion) {
            const currentVersion = hashContent(fs.readFileSync(filePath, 'utf8'));
            if (currentVersion !== expectedVersion) {
                return {
                    stale: true,
                    reason: `STALE_FILE_VERSION: content hash mismatch (expected: ${expectedVersion.slice(0, 8)}..., current: ${currentVersion.slice(0, 8)}...)`,
                    currentVersion,
                };
            }
        }

        return { stale: false, currentVersion: expectedVersion };
    } catch {
        return { stale: true, reason: 'FILE_NOT_FOUND' };
    }
}

/**
 * Re-check, immediately before a write, that a file still hashes to what the
 * caller read moments earlier (P5-T7). Closes the time-of-check-to-time-of-use
 * window between a tool reading a file's content and committing its edit: if an
 * external process changed the file in between, the edit was computed against
 * stale bytes and must be rejected rather than silently clobbering the change.
 * Independent of the optional `expectedVersion` the model may pass — this guards
 * the in-execution window even when the model didn't supply a version.
 */
export function verifyUnchangedSince(filePath: string, expectedHash: string): { ok: boolean; reason?: string } {
    try {
        const current = hashContent(fs.readFileSync(filePath, 'utf8'));
        if (current !== expectedHash) {
            return {
                ok: false,
                reason: `STALE_FILE_VERSION: file changed on disk during the edit (expected ${expectedHash.slice(0, 8)}..., now ${current.slice(0, 8)}...). Re-read the file and retry.`,
            };
        }
        return { ok: true };
    } catch {
        return { ok: false, reason: 'FILE_NOT_FOUND: file was removed during the edit' };
    }
}

/**
 * Write file atomically: write to temp file, then rename.
 * Preserves atomicity on crash and avoids partial writes.
 */
/**
 * Count lines added and removed between two file contents.
 * Uses line-by-line diff (same algorithm as createTwoFilesPatch) for accuracy.
 */
export function countLineDiff(oldContent: string, newContent: string): { added: number; removed: number } {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    let added = 0;
    let removed = 0;

    // Simple Myers-style diff via the diff library for accuracy
    // Falls back to length delta if lines are identical
    if (oldContent === newContent) return { added: 0, removed: 0 };

    const m = oldLines.length;
    const n = newLines.length;
    if (m === 0) return { added: n, removed: 0 };
    if (n === 0) return { added: 0, removed: m };

    // Use a fast LCS on normalized lines (trim trailing \r to avoid CRLF mismatches)
    const oldNorm = oldLines.map(l => l.replace(/\r$/, ''));
    const newNorm = newLines.map(l => l.replace(/\r$/, ''));

    const MAX_DIM = 5000;
    if (m > MAX_DIM || n > MAX_DIM) {
        return { added: Math.max(0, n - m), removed: Math.max(0, m - n) };
    }

    // Half-size LCS (keep only two diagonals for space efficiency isn't needed here,
    // but use the full DP for correctness on typical file sizes)
    const dp: number[][] = [];
    for (let i = 0; i <= m; i++) {
        dp[i] = [0];
    }
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldNorm[i - 1] === newNorm[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldNorm[i - 1] === newNorm[j - 1]) {
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            added++; j--;
        } else {
            removed++; i--;
        }
    }

    return { added, removed };
}

/**
 * Write file atomically: write to temp file, then rename.
 * Preserves atomicity on crash and avoids partial writes.
 */
export function atomicWrite(
    filePath: string,
    content: string,
    options?: { encoding?: string; lineEnding?: 'lf' | 'crlf' | 'auto' },
): void {
    // Normalize line endings if requested
    let finalContent = content;
    if (options?.lineEnding === 'crlf') {
        finalContent = content.replace(/\n/g, '\r\n');
    } else if (options?.lineEnding === 'lf') {
        finalContent = content.replace(/\r\n/g, '\n');
    } else if (options?.lineEnding === 'auto') {
        // Preserve existing line ending style
        const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
        if (existing.includes('\r\n')) {
            finalContent = content.replace(/\n/g, '\r\n');
        }
    }

    const encoding = options?.encoding ?? 'utf8';
    const tempPath = filePath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).slice(2);

    try {
        fs.writeFileSync(tempPath, finalContent, { encoding: encoding as BufferEncoding });
        fs.renameSync(tempPath, filePath);
    } catch (e) {
        // Clean up temp file on failure
        try {
            fs.unlinkSync(tempPath);
        } catch { /* ignore */ }
        throw e;
    }
}
