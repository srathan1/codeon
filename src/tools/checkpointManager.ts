import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { getWorkspaceRoot } from './pathSafety';

/**
 * Checkpoint system for recoverable file snapshots.
 * Stores patches in .codeon/checkpoints/ within the workspace.
 */

export interface CheckpointFile {
    beforeHash: string;
    afterHash?: string;
    path: string;
    /**
     * Whether the file existed at checkpoint time (P6-T8). When false, `restore`
     * DELETES the file if it exists — i.e. a file created after the checkpoint is
     * removed on revert. Undefined on checkpoints written before this field
     * existed; treated as "existed" (restore content only) for back-compat.
     */
    existedAtCheckpoint?: boolean;
}

export interface Checkpoint {
    id: string;
    label: string;
    createdAt: number;
    files: Record<string, CheckpointFile>;
    storageMethod: 'patch-journal' | 'git-stash';
}

const CHECKPOINTS_DIR = '.codeon/checkpoints';
const INDEX_FILE = 'index.json';

/**
 * Compute a SHA-256 hash (first 16 hex chars) of content.
 */
function hashContent(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Get the absolute path to the checkpoints directory.
 */
function getCheckpointsDir(): string {
    const workspaceRoot = getWorkspaceRoot();
    const cpDir = path.join(workspaceRoot, CHECKPOINTS_DIR);
    if (!fs.existsSync(cpDir)) {
        fs.mkdirSync(cpDir, { recursive: true });
    }
    return cpDir;
}

/**
 * Load the checkpoint index from disk.
 */
function loadIndex(): Checkpoint[] {
    try {
        const indexPath = path.join(getCheckpointsDir(), INDEX_FILE);
        if (fs.existsSync(indexPath)) {
            const raw = fs.readFileSync(indexPath, 'utf8');
            return JSON.parse(raw) as Checkpoint[];
        }
    } catch {
        // Corrupt or missing index — start fresh
    }
    return [];
}

/**
 * Save the checkpoint index to disk.
 */
function saveIndex(index: Checkpoint[]): void {
    const indexPath = path.join(getCheckpointsDir(), INDEX_FILE);
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
}

/**
 * Generate a unique checkpoint ID (timestamp + random suffix).
 */
function generateId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `cp_${ts}_${rand}`;
}

/**
 * Write a unified diff patch for a single file to the checkpoints directory.
 */
function writePatch(checkpointId: string, relPath: string, beforeContent: string, afterContent: string): string {
    const patchDir = path.join(getCheckpointsDir(), checkpointId);
    if (!fs.existsSync(patchDir)) {
        fs.mkdirSync(patchDir, { recursive: true });
    }

    // Sanitize the relative path for use as a filename
    const safeName = relPath.replace(/[/\\]/g, '__') + '.patch';
    const patchPath = path.join(patchDir, safeName);

    // Generate unified diff
    const beforeLines = beforeContent.split('\n');
    const afterLines = afterContent.split('\n');
    const patch = generateUnifiedDiff(beforeLines, afterLines, relPath);

    fs.writeFileSync(patchPath, patch, 'utf8');
    return patchPath;
}

/**
 * Minimal unified diff generator (avoids external dependency).
 */
function generateUnifiedDiff(oldLines: string[], newLines: string[], filePath: string): string {
    const header = `--- a/${filePath}\n+++ b/${filePath}\n`;

    // Simple LCS-based diff
    const lcs = computeLCS(oldLines, newLines);

    let result = header;
    let oi = 0; // old index
    let ni = 0; // new index
    let li = 0; // LCS index

    while (oi < oldLines.length || ni < newLines.length) {
        if (li < lcs.length) {
            // Output context/hunks before this LCS match
            const targetOld = lcs[li].oldIdx;
            const targetNew = lcs[li].newIdx;

            if (oi < targetOld || ni < targetNew) {
                // There are differences before this match
                const hunkStartOld = Math.max(0, oi - 2);
                const hunkStartNew = Math.max(0, ni - 2);

                result += `@@ -${hunkStartOld + 1},${targetOld - hunkStartOld + 1} +${hunkStartNew + 1},${targetNew - hunkStartNew + 1} @@\n`;

                // Context lines before the change
                for (let i = hunkStartOld; i < targetOld; i++) {
                    if (i < oldLines.length) result += ` ${oldLines[i]}\n`;
                }
                for (let i = hunkStartNew; i < targetNew; i++) {
                    if (i < newLines.length) result += `+${newLines[i]}\n`;
                }

                // Remove old-only lines
                for (let i = oi; i < targetOld; i++) {
                    if (!(i >= hunkStartOld && i < targetOld)) result += `-${oldLines[i]}\n`;
                }

                oi = targetOld;
                ni = targetNew;
            }

            // Output the matching line
            result += ` ${oldLines[oi]}\n`;
            oi++;
            ni++;
            li++;
        } else {
            // No more LCS matches — output remaining as additions/deletions
            while (oi < oldLines.length) {
                result += `-${oldLines[oi]}\n`;
                oi++;
            }
            while (ni < newLines.length) {
                result += `+${newLines[ni]}\n`;
                ni++;
            }
        }
    }

    return result;
}

interface LCSMatch {
    oldIdx: number;
    newIdx: number;
}

function computeLCS(oldLines: string[], newLines: string[]): LCSMatch[] {
    // Use a simplified approach for performance on large files
    const m = oldLines.length;
    const n = newLines.length;

    // For very large files, use a line-hash based approach
    if (m > 5000 || n > 5000) {
        return computeHashBasedMatches(oldLines, newLines);
    }

    // Standard DP for smaller files
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack to find matches
    const matches: LCSMatch[] = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
        if (oldLines[i - 1] === newLines[j - 1]) {
            matches.unshift({ oldIdx: i - 1, newIdx: j - 1 });
            i--;
            j--;
        } else if (dp[i - 1][j] > dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    return matches;
}

function computeHashBasedMatches(oldLines: string[], newLines: string[]): LCSMatch[] {
    // Hash-based matching for large files
    const oldHashes = new Map<string, number[]>();
    for (let i = 0; i < oldLines.length; i++) {
        const h = oldLines[i];
        if (!oldHashes.has(h)) oldHashes.set(h, []);
        oldHashes.get(h)!.push(i);
    }

    const matches: LCSMatch[] = [];
    let lastOldIdx = -1;
    let lastNewIdx = -1;

    for (let j = 0; j < newLines.length; j++) {
        const indices = oldHashes.get(newLines[j]);
        if (indices) {
            // Find the first index > lastOldIdx
            for (const idx of indices) {
                if (idx > lastOldIdx) {
                    matches.push({ oldIdx: idx, newIdx: j });
                    lastOldIdx = idx;
                    lastNewIdx = j;
                    break;
                }
            }
        }
    }

    return matches;
}

/**
 * Apply a patch file to restore content.
 */
function applyPatchFromFile(patchPath: string, targetPath: string): boolean {
    try {
        const patch = fs.readFileSync(patchPath, 'utf8');
        const currentContent = fs.readFileSync(targetPath, 'utf8');

        // Parse the patch and reverse-apply it (since we stored forward diff,
        // to restore "before" we need to reverse it)
        const reversed = reversePatch(patch);
        const restored = applySimplePatch(currentContent, reversed);

        if (restored !== null) {
            fs.writeFileSync(targetPath, restored, 'utf8');
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Reverse a unified diff patch (swap ---/+++ and +/- lines).
 */
function reversePatch(patch: string): string {
    return patch
        .replace(/^--- (.*)\n\+\+\+ (.*)\n/m, '+++ $1\n--- $2\n')
        .split('\n')
        .map(line => {
            if (line.startsWith('+')) return '-' + line.slice(1);
            if (line.startsWith('-')) return '+' + line.slice(1);
            return line;
        })
        .join('\n');
}

/**
 * Apply a simple unified diff patch to content.
 */
function applySimplePatch(content: string, patch: string): string | null {
    const contentLines = content.split('\n');
    const patchLines = patch.split('\n');

    // Find hunks
    const hunks: Array<{ oldStart: number; oldCount: number; lines: string[] }> = [];
    let currentHunk: typeof hunks[number] | null = null;

    for (const line of patchLines) {
        const hunkMatch = line.match(/^@@ -(\d+),(\d+) \+\d+,\d+ @@$/);
        if (hunkMatch) {
            if (currentHunk) hunks.push(currentHunk);
            currentHunk = {
                oldStart: parseInt(hunkMatch[1], 10) - 1,
                oldCount: parseInt(hunkMatch[2], 10),
                lines: [],
            };
        } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
            currentHunk.lines.push(line);
        }
    }
    if (currentHunk) hunks.push(currentHunk);

    // Apply hunks in reverse order (to preserve line numbers)
    const result = [...contentLines];
    for (let h = hunks.length - 1; h >= 0; h--) {
        const hunk = hunks[h];
        const start = hunk.oldStart;

        // Build replacement
        const replacement: string[] = [];
        for (const line of hunk.lines) {
            if (line.startsWith('-')) continue; // Skip removed lines
            replacement.push(line.startsWith('+') ? line.slice(1) : line.slice(1));
        }

        result.splice(start, hunk.oldCount, ...replacement);
    }

    return result.join('\n');
}

/**
 * CheckpointManager — manages file-level checkpoints with patch journaling.
 */
export class CheckpointManager {
    /**
     * Create a checkpoint capturing the current state of specified files.
     * Writes the before-state as a patch journal entry.
     */
    public create(label: string, files: Array<{ path: string; hash: string }>): Checkpoint {
        const workspaceRoot = getWorkspaceRoot();
        const id = generateId();
        const checkpointFiles: Record<string, CheckpointFile> = {};

        for (const file of files) {
            const absPath = path.resolve(workspaceRoot, file.path);
            const existed = fs.existsSync(absPath);
            try {
                if (!existed) {
                    // File doesn't exist yet — record that so restore can DELETE it
                    // (undo a creation) rather than leaving it behind.
                    checkpointFiles[file.path] = {
                        beforeHash: '(absent)',
                        path: file.path,
                        existedAtCheckpoint: false,
                    };
                    continue;
                }

                const content = fs.readFileSync(absPath, 'utf8');
                const actualHash = hashContent(content);

                checkpointFiles[file.path] = {
                    beforeHash: actualHash,
                    path: file.path,
                    existedAtCheckpoint: true,
                };

                // Store the original content for restoration
                const contentDir = path.join(getCheckpointsDir(), id, 'contents');
                if (!fs.existsSync(contentDir)) {
                    fs.mkdirSync(contentDir, { recursive: true });
                }
                const safeName = file.path.replace(/[/\\]/g, '__') + '.orig';
                fs.writeFileSync(path.join(contentDir, safeName), content, 'utf8');
            } catch {
                // File not readable — skip with recorded hash
                checkpointFiles[file.path] = {
                    beforeHash: file.hash,
                    path: file.path,
                    existedAtCheckpoint: existed,
                };
            }
        }

        const checkpoint: Checkpoint = {
            id,
            label,
            createdAt: Date.now(),
            files: checkpointFiles,
            storageMethod: 'patch-journal',
        };

        const index = loadIndex();
        index.push(checkpoint);
        saveIndex(index);

        return checkpoint;
    }

    /**
     * List all checkpoints (most recent first).
     */
    public list(): Checkpoint[] {
        const index = loadIndex();
        return index.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Get a checkpoint by ID.
     */
    public get(id: string): Checkpoint | undefined {
        return loadIndex().find(cp => cp.id === id);
    }

    /**
     * Restore files to their state at the given checkpoint.
     */
    public async restore(id: string): Promise<void> {
        const checkpoint = this.get(id);
        if (!checkpoint) {
            throw new Error(`CHECKPOINT_NOT_FOUND: '${id}'`);
        }

        const workspaceRoot = getWorkspaceRoot();
        const cpDir = path.join(getCheckpointsDir(), id);

        if (checkpoint.storageMethod === 'patch-journal') {
            const contentDir = path.join(cpDir, 'contents');
            const rootSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;

            for (const [relPath, fileInfo] of Object.entries(checkpoint.files)) {
                try {
                    const targetPath = path.resolve(workspaceRoot, relPath);

                    // P6-T8: never write/delete outside the workspace, even if a
                    // tampered index contains a traversal path.
                    if (targetPath !== workspaceRoot && !targetPath.startsWith(rootSep)) {
                        console.warn(`[checkpoint] Refusing to restore out-of-workspace path: ${relPath}`);
                        continue;
                    }

                    // P6-T8: a file that did NOT exist at checkpoint time is a
                    // post-checkpoint creation — delete it to fully revert.
                    if (fileInfo.existedAtCheckpoint === false) {
                        if (fs.existsSync(targetPath)) {
                            fs.rmSync(targetPath, { force: true });
                        }
                        fileInfo.afterHash = '(deleted)';
                        continue;
                    }

                    const safeName = relPath.replace(/[/\\]/g, '__') + '.orig';
                    const origPath = path.join(contentDir, safeName);
                    if (fs.existsSync(origPath)) {
                        const restoredContent = fs.readFileSync(origPath, 'utf8');
                        fs.writeFileSync(targetPath, restoredContent, 'utf8');
                        fileInfo.afterHash = hashContent(restoredContent);
                    }
                } catch {
                    // File restore failed — continue with other files
                }
            }
        }

        // Update the index with after hashes
        const index = loadIndex();
        const idx = index.findIndex(cp => cp.id === id);
        if (idx >= 0) {
            index[idx] = checkpoint;
            saveIndex(index);
        }
    }

    /**
     * Delete a checkpoint and its associated data.
     */
    public delete(id: string): boolean {
        const cpDir = path.join(getCheckpointsDir(), id);

        // Remove checkpoint data directory
        try {
            if (fs.existsSync(cpDir)) {
                fs.rmSync(cpDir, { recursive: true, force: true });
            }
        } catch {
            // Ignore cleanup errors
        }

        // Remove from index
        const index = loadIndex().filter(cp => cp.id !== id);
        saveIndex(index);
        return true;
    }
}

/** Singleton instance. */
export const checkpointManager = new CheckpointManager();

/**
 * P5-T17: auto-snapshot the workspace's uncommitted (dirty) files before a
 * destructive shell command, so file-level fallout can be reverted via the
 * checkpoint system even though the command itself has no undo. Only covers
 * file changes — it cannot undo network calls, installed packages, or pushes.
 *
 * Uses `git status --porcelain` to bound the snapshot to files that actually
 * have uncommitted work (the ones a destructive command would irreversibly
 * lose); a full-workspace snapshot would be unboundedly large. Best-effort:
 * returns null when not a git repo, when nothing is dirty, or on any error, so
 * it can never block or fail the command it precedes.
 */
export async function autoCheckpointBeforeDangerousCommand(command: string): Promise<Checkpoint | null> {
    try {
        const { runGitCommand } = await import('./gitCommandRunner');
        const workspaceRoot = getWorkspaceRoot();

        const porcelain = await runGitCommand(workspaceRoot, ['status', '--porcelain']);
        const dirtyPaths = porcelain
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            // Porcelain format: "XY <path>" (or "XY <old> -> <new>" for renames).
            .map(line => {
                const rest = line.slice(2).trim();
                const arrow = rest.indexOf(' -> ');
                return arrow >= 0 ? rest.slice(arrow + 4) : rest;
            })
            .filter(p => p && !p.endsWith('/')); // skip directories

        if (dirtyPaths.length === 0) return null;

        // Cap to a sane number so a huge working tree doesn't stall the command.
        const capped = dirtyPaths.slice(0, 200);
        const label = `auto: before "${command.slice(0, 60)}"`;
        return checkpointManager.create(label, capped.map(p => ({ path: p, hash: '' })));
    } catch {
        return null;
    }
}
