import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Workspace path safety utilities.
 * Enforces workspace boundaries, resolves symlinks, and prevents path traversal.
 */

/** Get the first workspace root (or throw). */
export function getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('No workspace folder open');
    return folders[0].uri.fsPath;
}

/**
 * Get all workspace roots for multi-root workspace support.
 */
export function getAllWorkspaceRoots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
}

/**
 * Resolve symlinks for the nearest EXISTING ancestor of `p`, then re-append
 * whatever path segments don't exist yet (H-7/L-5). A plain
 * `fs.existsSync(p)` gate skips symlink resolution entirely for a path that
 * doesn't exist yet — e.g. a brand-new file about to be created inside a
 * symlinked PARENT directory that points outside the workspace previously
 * went unchecked, because the full target path itself didn't exist. Walking
 * up to the nearest real ancestor closes that gap for new files/directories
 * while still resolving fully for existing ones.
 */
function realpathNearestExisting(p: string): string {
    let current = p;
    const remainder: string[] = [];
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) {
            // Reached the filesystem root without finding an existing
            // ancestor — nothing to resolve, return the original path.
            return p;
        }
        remainder.unshift(path.basename(current));
        current = parent;
    }
    try {
        const real = fs.realpathSync(current);
        return remainder.length > 0 ? path.join(real, ...remainder) : real;
    } catch {
        return p;
    }
}

/**
 * Canonicalize a path: resolve symlinks, normalize case, and remove trailing separators.
 */
export function canonicalizePath(p: string): string {
    // Resolve to absolute path
    const abs = path.resolve(p);
    return realpathNearestExisting(abs);
}

/**
 * Resolve a workspace-relative path to an absolute path and enforce workspace boundary.
 * Performs symlink resolution and path traversal detection.
 *
 * @param relPath - Workspace-relative path from the tool call
 * @param workspaceRoot - The approved workspace root (defaults to first workspace folder)
 * @returns The resolved absolute path
 * @throws Error if path escapes workspace, contains traversal, or follows symlink outside workspace
 */
export function resolveWorkspacePath(relPath: string, workspaceRoot?: string): string {
    if (!relPath || typeof relPath !== 'string') {
        throw new Error('PATH_OUTSIDE_WORKSPACE: empty or invalid path');
    }

    const root = workspaceRoot ?? getWorkspaceRoot();
    // Ensure root has trailing separator for startsWith check
    const rootSep = root.endsWith(path.sep) ? root : root + path.sep;

    // Resolve the path
    const resolved = path.resolve(root, relPath);

    // Check basic traversal before any filesystem access
    if (!resolved.startsWith(rootSep) && resolved !== root) {
        throw new Error(`PATH_TRAVERSAL_DETECTED: ${relPath}`);
    }

    // H-7: resolve symlinks for the nearest existing ancestor unconditionally
    // (not gated on the target itself existing) — a symlinked PARENT
    // directory pointing outside the workspace previously escaped this check
    // entirely for any path that didn't exist yet (e.g. a file about to be
    // created), because the old gate was `if (fs.existsSync(resolved))`.
    const real = realpathNearestExisting(resolved);
    if (!real.startsWith(rootSep) && real !== root) {
        throw new Error(`SYMLINK_ESCAPE_DETECTED: ${relPath} resolves outside workspace`);
    }
    return real;
}

/**
 * Check if an absolute path is within any approved workspace root.
 */
export function isInsideWorkspace(absPath: string): boolean {
    const roots = getAllWorkspaceRoots();
    for (const root of roots) {
        const rootSep = root.endsWith(path.sep) ? root : root + path.sep;
        if (absPath === root || absPath.startsWith(rootSep)) {
            return true;
        }
    }
    return false;
}

/** Default protected file/directory patterns (from PRD §9.2). */
const DEFAULT_PROTECTED_PATTERNS = [
    /^\.env$/,
    /^\.env\./,
    /\.pem$/,
    /\.key$/,
    /\.p12$/,
    /\.pfx$/,
    /\/id_rsa$/,
    /\/id_ed25519$/,
    /\/\.aws\/credentials$/,
    /\/\.azure\//,
    /\/\.gnupg\//,
    /\/\.ssh\//,
    /^npmrc$/,
    /^pypirc$/,
    /^terraform\.tfstate/,
    /\.codeon[\\/]/, // audit log / approval rules — see isAuditTrailPath below for the hard-deny path
];

/**
 * Check if a path matches a protected/sensitive pattern.
 *
 * P5-T8: the DEFAULT_PROTECTED_PATTERNS use forward slashes (e.g. /\/\.ssh\//),
 * but on Windows path.resolve/path.basename produce backslash-separated paths,
 * so those patterns would never match a native `C:\Users\x\.ssh\id_rsa` — the
 * credential guard was silently absent on Windows. Normalizing separators to `/`
 * before testing makes the same patterns fire on both platforms.
 */
export function isProtectedPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const basename = path.basename(normalized);
    return DEFAULT_PROTECTED_PATTERNS.some(p => p.test(basename) || p.test(normalized));
}

/**
 * Sensitive filename fragments to look for inside a shell command string.
 * Unlike isProtectedPath(), this doesn't anchor to a path basename — a command
 * can reference a protected file relatively, via ~-expansion, as an argument to
 * an arbitrary program (cat, cp, curl --data-binary @file, grep, ...), or with
 * either path separator. This is what lets execute_command's risk classification
 * catch `cat ~/.ssh/id_rsa` the same way write_file/edit_file already catch a
 * direct write to that path (P5-T2) — file-tool access and shell access to the
 * same sensitive file should carry the same risk escalation.
 */
const COMMAND_PROTECTED_FRAGMENTS: RegExp[] = [
    /\.env\b/,
    /\.pem\b/,
    /\.key\b/,
    /\.p12\b/,
    /\.pfx\b/,
    /\bid_rsa\b/,
    /\bid_ed25519\b/,
    /\.aws[\\/]credentials/,
    /\.azure[\\/]/,
    /\.gnupg[\\/]/,
    /\.ssh[\\/]/,
    /\.npmrc\b/,
    /\.pypirc\b/,
    /terraform\.tfstate/,
];

/**
 * Check whether a raw shell command string references a protected/sensitive
 * file, for risk classification of execute_command invocations.
 */
export function commandReferencesProtectedPath(command: string): boolean {
    return COMMAND_PROTECTED_FRAGMENTS.some(p => p.test(command));
}

/**
 * P5-T3: the extension's own audit log and approval-rules store. These must be
 * unconditionally denied to any tool — not merely escalated to an approvable
 * risk tier — because approving a write here would let the model tamper with
 * or erase the record of its own actions. Checked separately from
 * isProtectedPath()/commandReferencesProtectedPath() so this specific case can
 * map to a hard R5 deny (see riskModel.classifyRisk's targetsAuditTrail factor)
 * instead of the normal approvable R3 escalation.
 */
const AUDIT_TRAIL_PATTERN = /\.codeon[\\/]/;

/** Check if an absolute/relative file path falls under the .codeon/ audit directory. */
export function isAuditTrailPath(filePath: string): boolean {
    return AUDIT_TRAIL_PATTERN.test(filePath);
}

/** Check if a shell command references the .codeon/ audit directory. */
export function commandReferencesAuditTrail(command: string): boolean {
    return AUDIT_TRAIL_PATTERN.test(command);
}

/**
 * Convert an absolute path to a workspace-relative display path.
 */
export function toWorkspaceRelative(absPath: string, workspaceRoot?: string): string {
    const root = workspaceRoot ?? getWorkspaceRoot();
    return path.relative(root, absPath);
}
