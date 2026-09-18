import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot, resolveWorkspacePath } from '../pathSafety';
import { getCachedGitRepository, refreshGitRepositoryState } from '../gitRepositoryCache';

interface GitRepository {
    state: { HEAD?: { name?: string } };
}

/**
 * git_log tool (Phase 4, R0).
 * Returns recent commit history with optional filters (path, author, limit).
 */
export class GitLogExecutor implements ToolExecutor {
    public name = 'git_log';

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
            const repo = cached.repo as unknown as GitRepository;

            const limit = args.limit !== undefined ? Math.max(1, Math.min(Number(args.limit), 500)) : 20;
            const relPath = args.path ? String(args.path) : undefined;
            const author = args.author ? String(args.author) : undefined;

            // Build format string — use a delimiter unlikely in commit messages
            const fmt = '%H%n%an%n%ae%n%ad%n%s%n%B---COMMIT_SEP---';
            // Use array args to avoid Windows quoting issues with format strings and author names
            const gitArgs: string[] = ['log', '--format', fmt, '--date=iso-strict', '-n', String(limit)];

            // Filter by path
            if (relPath) {
                const workspaceRoot = getWorkspaceRoot();
                const absPath = resolveWorkspacePath(relPath, workspaceRoot);
                const repoRelative = toRepoRelative(cached.rootPath, absPath);
                gitArgs.push('--', repoRelative);
            }

            // Filter by author
            if (author) {
                gitArgs.push('--author', author);
            }

            const { runGitCommand } = await import('../gitCommandRunner');
            const rawOutput = await runGitCommand(cached.rootPath, gitArgs);

            // Parse commits
            const commits = parseCommitLog(rawOutput);

            const output = {
                repository: cached.rootPath,
                branch: repo.state.HEAD?.name ?? '(unknown)',
                limit,
                path: relPath ?? '(all files)',
                author: author ?? '(all authors)',
                count: commits.length,
                commits,
            };

            return { success: true, output: JSON.stringify(output, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

interface ParsedCommit {
    hash: string;
    shortHash: string;
    authorName: string;
    authorEmail: string;
    date: string;
    subject: string;
    body: string;
}

function parseCommitLog(raw: string): ParsedCommit[] {
    const commits: ParsedCommit[] = [];
    // Split on the separator between commits
    const blocks = raw.split('---COMMIT_SEP---').filter(b => b.trim());

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 5) continue;

        const hash = lines[0].trim();
        const authorName = lines[1].trim();
        const authorEmail = lines[2].trim();
        const date = lines[3].trim();
        const subject = lines[4].trim();
        const body = lines.slice(5).join('\n').trim();

        if (hash) {
            commits.push({
                hash,
                shortHash: hash.slice(0, 8),
                authorName,
                authorEmail,
                date,
                subject,
                body,
            });
        }
    }

    return commits;
}

function toRepoRelative(repoRoot: string, absPath: string): string {
    const sep = require('path').sep;
    const rootSep = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep;
    if (absPath.startsWith(rootSep)) {
        return absPath.slice(rootSep.length);
    }
    return absPath;
}
