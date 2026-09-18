import * as fs from 'fs';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, isProtectedPath } from '../pathSafety';
import { hashContent } from '../fileVersion';

/** Max paths accepted in one batch call — keeps a single tool call bounded. */
const MAX_BATCH_PATHS = 500;

export class StatPathExecutor implements ToolExecutor {
    public name = 'stat_path';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const followSymlink = args.followSymlink === true;

        // Batch mode: a separate `paths` array param (rather than
        // overloading `path` to accept string|string[] — this codebase's
        // tool schemas have no precedent for union-typed params, and an
        // ambiguous schema risks confusing weaker function-calling models).
        // One result per path, in one tool call — added so an agent stat-ing
        // dozens of files (e.g. for a line count) isn't forced into one
        // round-trip per file. A bad path in a batch is reported per-entry,
        // not a whole-call failure — one unreadable file shouldn't lose
        // every other result in the batch.
        if (Array.isArray(args.paths)) {
            const paths = args.paths.map(p => String(p));
            if (paths.length === 0) {
                return { success: false, output: '', error: 'EMPTY_PATH_LIST: path array must contain at least one path' };
            }
            if (paths.length > MAX_BATCH_PATHS) {
                return { success: false, output: '', error: `TOO_MANY_PATHS: batch limited to ${MAX_BATCH_PATHS} paths, got ${paths.length}` };
            }
            const results = paths.map(p => statOne(p, followSymlink));
            return { success: true, output: JSON.stringify(results, null, 2) };
        }

        if (args.path === undefined) {
            return { success: false, output: '', error: 'MISSING_ARGUMENT: provide either path (a single string) or paths (an array of strings)' };
        }

        try {
            const relPath = String(args.path || '');
            const result = statOne(relPath, followSymlink);
            if (result.error) {
                return { success: false, output: '', error: String(result.error) };
            }
            return { success: true, output: JSON.stringify(result, null, 2) };
        } catch (e) {
            const err = e as Error;
            return { success: false, output: '', error: err.message };
        }
    }
}

/** Stat a single path, returning a plain result object. Errors are returned
 * as `{ path, error }` rather than thrown, so a batch caller can report a
 * per-path failure without losing the rest of the batch. */
function statOne(relPath: string, followSymlink: boolean): Record<string, unknown> {
    try {
        const target = resolveWorkspacePath(relPath);

        if (isProtectedPath(target)) {
            return { path: relPath, error: `PROTECTED_PATH: ${relPath}` };
        }

        if (!fs.existsSync(target)) {
            return { exists: false, path: relPath };
        }

        let stat: fs.Stats;
        if (followSymlink) {
            stat = fs.statSync(target);
        } else {
            stat = fs.lstatSync(target);
        }

        const result: Record<string, unknown> = {
            exists: true,
            path: relPath,
            type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            permissions: stat.mode.toString(8).slice(-3),
        };

        // Symlink target
        if (stat.isSymbolicLink()) {
            try {
                result.symlinkTarget = fs.readlinkSync(target);
            } catch { /* ignore */ }
        }

        // Content hash for small files
        if (stat.isFile() && stat.size < 1_000_000) {
            try {
                const content = fs.readFileSync(target, 'utf8');
                result.contentHash = hashContent(content);
                result.encoding = detectEncoding(content);
                result.lineEnding = content.includes('\r\n') ? 'crlf' : 'lf';
                result.binary = false;
                // Free — content is already read for the hash above. Gives
                // callers (agents especially) a way to answer "how many
                // lines is this file" without read_file's much heavier cost
                // of returning the full content back into the model's own
                // context/turn budget.
                result.lineCount = content.split('\n').length;
            } catch {
                result.binary = true;
            }
        }

        return result;
    } catch (e) {
        const err = e as Error;
        return { path: relPath, error: err.message };
    }
}

function detectEncoding(text: string): string {
    // Basic heuristic — check for BOM or common patterns
    if (text.startsWith('\uFEFF')) return 'utf8-bom';
    return 'utf8';
}
