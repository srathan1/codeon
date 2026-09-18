import * as vscode from 'vscode';

/** Cached reference to the first Git repository from VS Code's built-in Git extension. */
interface CachedGitRepo {
    /** The raw repository object from the Git extension API. */
    repo: unknown;
    /** File-system path of the repository root. */
    rootPath: string;
}

let _cachedRepo: CachedGitRepo | null = null;

/**
 * Get the first Git repository from VS Code's built-in Git extension.
 * Caches the result so subsequent calls avoid the async extension lookup.
 *
 * Returns `null` if no Git extension is loaded or no repositories are open.
 */
export function getCachedGitRepository(): CachedGitRepo | null {
    if (_cachedRepo) {
        return _cachedRepo;
    }

    try {
        const ext = vscode.extensions.getExtension('vscode.git');
        if (!ext) return null;

        const api = ext.exports.getAPI(1);
        const repos = api.repositories;
        if (!repos || repos.length === 0) return null;

        // Extract the first repo — cast loosely because the Git extension types
        // are not published as a separate npm package.
        const firstRepo = repos[0];
        const rootUri = firstRepo.rootUri;
        const rootPath = typeof rootUri?.fsPath === 'string' ? rootUri.fsPath : '';

        _cachedRepo = { repo: firstRepo, rootPath };
        return _cachedRepo;
    } catch {
        return null;
    }
}

/**
 * Force VS Code's built-in Git extension to refresh its internal repository
 * state before a caller reads `repo.state`.
 *
 * The extension populates `repo.state` from a debounced file-system watcher,
 * not synchronously on every disk write — a git executor called immediately
 * after this session's own write_file/execute_command (e.g. git_status right
 * after creating a file) can otherwise read a stale, pre-write snapshot.
 * `repo.status()` is the Git extension API's own documented way to force
 * that refresh and await its completion.
 *
 * Best-effort: if `.status()` throws or isn't present (e.g. a test stub that
 * doesn't implement the full Git extension API), callers fall back to
 * whatever state is already cached rather than failing the tool call.
 */
export async function refreshGitRepositoryState(repo: unknown): Promise<void> {
    try {
        await (repo as { status?: () => Promise<void> }).status?.();
    } catch {
        // Best-effort — proceed with whatever state is already cached.
    }
}
