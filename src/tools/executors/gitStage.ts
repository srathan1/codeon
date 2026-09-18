import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot, resolveWorkspacePath } from '../pathSafety';
import { getCachedGitRepository, refreshGitRepositoryState } from '../gitRepositoryCache';

/* ------------------------------------------------------------------ */
/*  Local shapes for VS Code Git extension types (untyped in strict)  */
/* ------------------------------------------------------------------ */

interface GitChange {
    uri?: { fsPath: string };
}

interface GitWorkingTreeState {
    changes?: GitChange[];
}

interface GitRepository {
    state: GitWorkingTreeState;
    add(uri: { fsPath: string }): Promise<void>;
}

/* ------------------------------------------------------------------ */

/**
 * git_stage tool (Phase 4, R2).
 * Stage selected paths using VS Code's Git API.
 */
export class GitStageExecutor implements ToolExecutor {
    public name = 'git_stage';

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

            const workspaceRoot = getWorkspaceRoot();
            const stagedFiles: string[] = [];
            const errors: Array<{ path: string; error: string }> = [];

            // Attempt VS Code Git API first for each path, collect failures
            const apiFailures: string[] = [];

            for (const relPath of paths) {
                try {
                    const absPath = resolveWorkspacePath(relPath, workspaceRoot);
                    const uri = vscode.Uri.file(absPath);

                    await repo.add(uri);
                    stagedFiles.push(relPath);
                } catch {
                    // Collect for batched shell fallback
                    apiFailures.push(relPath);
                }
            }

            // Batch-fallback: use a single `git add` for all API failures
            if (apiFailures.length > 0) {
                try {
                    const { runGitCommand } = await import('../gitCommandRunner');
                    await runGitCommand(cached.rootPath, `add ${apiFailures.join(' ')}`);
                    stagedFiles.push(...apiFailures);
                } catch (e) {
                    // If batch fails, try individually
                    for (const relPath of apiFailures) {
                        try {
                            const { runGitCommand } = await import('../gitCommandRunner');
                            await runGitCommand(cached.rootPath, `add ${relPath}`);
                            stagedFiles.push(relPath);
                        } catch (innerErr) {
                            errors.push({ path: relPath, error: (innerErr as Error).message });
                        }
                    }
                }
            }

            const output = {
                action: 'stage',
                repository: cached.rootPath,
                staged: stagedFiles,
                stagedCount: stagedFiles.length,
                errors: errors.length > 0 ? errors : undefined,
            };

            return {
                success: errors.length < paths.length,
                output: JSON.stringify(output, null, 2),
                error: errors.length > 0 ? `${errors.length} path(s) failed to stage` : undefined,
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
