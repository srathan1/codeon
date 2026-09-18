import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot, resolveWorkspacePath } from '../pathSafety';
import { getCachedGitRepository, refreshGitRepositoryState } from '../gitRepositoryCache';

interface GitRepository {
    // no methods needed for restore — uses shell commands
}

/**
 * git_restore tool (Phase 4, R3).
 * Restore working tree or staged content to a given source.
 */
export class GitRestoreExecutor implements ToolExecutor {
    public name = 'git_restore';

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

            const rawPaths = args.paths;

            let paths: string[];
            if (typeof rawPaths === 'string' && rawPaths.length > 0) {
                try { paths = JSON.parse(rawPaths); } catch {
                    return { success: false, output: '', error: 'INVALID_PATHS: paths must be a valid JSON array string' };
                }
            } else if (Array.isArray(rawPaths)) {
                paths = rawPaths.map(String);
            } else {
                return { success: false, output: '', error: 'MISSING_PATHS: paths array is required and must not be empty' };
            }

            paths = paths.map((p: unknown) => String(p)).filter(Boolean);
            if (paths.length === 0) {
                return { success: false, output: '', error: 'MISSING_PATHS: no valid paths provided' };
            }

            const source = args.source ? String(args.source).toLowerCase() : 'head';
            const target = args.target ? String(args.target).toLowerCase() : 'workingtree';
            const dryRun = Boolean(args.dryRun);

            // Validate source
            if (!['head', 'staging'].includes(source)) {
                return { success: false, output: '', error: `INVALID_SOURCE: '${source}' — use 'HEAD' or 'staging'` };
            }

            // Validate target
            if (!['workingtree', 'staged'].includes(target)) {
                return { success: false, output: '', error: `INVALID_TARGET: '${target}' — use 'workingtree' or 'staged'` };
            }

            // Resolve workspace-relative paths
            const workspaceRoot = getWorkspaceRoot();
            for (const relPath of paths) {
                resolveWorkspacePath(relPath, workspaceRoot);
            }

            // Determine the git command based on source/target combination
            let gitArgs: string;
            if (target === 'workingtree') {
                if (source === 'head') {
                    gitArgs = `checkout HEAD -- ${paths.join(' ')}`;
                } else {
                    gitArgs = `checkout -- ${paths.join(' ')}`;
                }
            } else if (target === 'staged') {
                if (source === 'head') {
                    gitArgs = `reset HEAD -- ${paths.join(' ')}`;
                } else {
                    // staging -> staging is a no-op
                    gitArgs = '';
                }
            } else {
                gitArgs = '';
            }

            const restoredFiles: string[] = [];
            const errors: Array<{ path: string; error: string }> = [];

            if (!dryRun && gitArgs) {
                try {
                    const { runGitCommand } = await import('../gitCommandRunner');
                    await runGitCommand(cached.rootPath, gitArgs);
                    restoredFiles.push(...paths);
                } catch (e) {
                    // Batch failed — try individually
                    for (const relPath of paths) {
                        try {
                            const { runGitCommand } = await import('../gitCommandRunner');
                            const singleArg = gitArgs.replace(paths.join(' '), relPath);
                            await runGitCommand(cached.rootPath, singleArg);
                            restoredFiles.push(relPath);
                        } catch (innerErr) {
                            errors.push({ path: relPath, error: (innerErr as Error).message });
                        }
                    }
                }
            } else if (!dryRun) {
                // No-op case (staging -> staging)
                restoredFiles.push(...paths);
            } else {
                // Dry run — just report what would happen
                restoredFiles.push(...paths);
            }

            const output: Record<string, unknown> = {
                action: 'restore',
                repository: cached.rootPath,
                source,
                target,
                dryRun,
                restored: restoredFiles,
                restoredCount: restoredFiles.length,
                errors: errors.length > 0 ? errors : undefined,
            };

            if (dryRun) {
                output.note = 'DRY_RUN: no changes were made';
            }

            return {
                success: errors.length < paths.length,
                output: JSON.stringify(output, null, 2),
                error: errors.length > 0 ? `${errors.length} path(s) failed to restore` : undefined,
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
