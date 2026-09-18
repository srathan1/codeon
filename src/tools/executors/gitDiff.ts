import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot, resolveWorkspacePath } from '../pathSafety';
import { getCachedGitRepository, refreshGitRepositoryState } from '../gitRepositoryCache';

interface GitRepository {
    // no methods needed for diff — uses shell commands
}

/**
 * git_diff tool (Phase 4, R0).
 * Returns staged or unstaged diff for a file or the entire working tree.
 */
export class GitDiffExecutor implements ToolExecutor {
    public name = 'git_diff';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const cached = getCachedGitRepository();
            if (!cached) {
                return { success: false, output: '', error: 'GIT_NOT_AVAILABLE: no Git repository found or Git extension not loaded' };
            }
            // Force a fresh read of repo.state before using it — see
            // refreshGitRepositoryState's doc comment for why (VS Code's Git
            // extension debounces its own state refresh, so a git tool call
            // made immediately after this session's own write_file/
            // execute_command could otherwise see a stale pre-write snapshot).
            await refreshGitRepositoryState(cached.repo);

            const mode = String(args.mode || 'unstaged').toLowerCase();
            const relPath = args.path ? String(args.path) : undefined;
            const maxBytes = args.maxBytes !== undefined ? Number(args.maxBytes) : 1_000_000;

            // Validate mode
            if (!['staged', 'unstaged', 'head'].includes(mode)) {
                return { success: false, output: '', error: `INVALID_MODE: '${mode}' — use 'staged', 'unstaged', or 'HEAD'` };
            }

            // Resolve optional path
            let targetPath: string | undefined;
            if (relPath) {
                const workspaceRoot = getWorkspaceRoot();
                targetPath = resolveWorkspacePath(relPath, workspaceRoot);
            }

            // Build git command
            let gitArgs: string;
            if (mode === 'staged') {
                gitArgs = 'diff --cached';
            } else if (mode === 'head') {
                gitArgs = 'diff HEAD';
            } else {
                gitArgs = 'diff';
            }

            if (targetPath) {
                const repoRelative = toRepoRelative(cached.rootPath, targetPath);
                gitArgs += ` -- ${repoRelative}`;
            }

            const { runGitCommand } = await import('../gitCommandRunner');
            const result = await runGitCommand(cached.rootPath, gitArgs, { maxBytes });

            const output = {
                mode,
                path: relPath ?? '(all files)',
                repository: cached.rootPath,
                bytes: Buffer.byteLength(result, 'utf8'),
                diff: result,
            };

            return { success: true, output: JSON.stringify(output, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

function toRepoRelative(repoRoot: string, absPath: string): string {
    const sep = require('path').sep;
    const rootSep = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep;
    if (absPath.startsWith(rootSep)) {
        return absPath.slice(rootSep.length);
    }
    return absPath;
}
