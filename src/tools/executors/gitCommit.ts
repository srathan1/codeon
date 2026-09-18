import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getCachedGitRepository, refreshGitRepositoryState } from '../gitRepositoryCache';

/* ------------------------------------------------------------------ */
/*  Local shapes for VS Code Git extension types (untyped in strict)  */
/* ------------------------------------------------------------------ */

interface GitChange {
    uri?: { fsPath: string };
    type: string;
    resourceGroup?: { id: string };
}

interface GitRepository {
    state: { HEAD?: { name?: string }; changes?: GitChange[] };
    rootUri: { fsPath: string };
    commit(message: string, options?: Record<string, unknown>): Promise<string | undefined>;
}

/* ------------------------------------------------------------------ */

/**
 * git_commit tool (Phase 4, R3).
 * Create a local commit from staged changes using VS Code's Git API,
 * with a shell fallback when the API cannot detect staged changes
 * (e.g. files staged via `git add` outside the extension host).
 */
export class GitCommitExecutor implements ToolExecutor {
    public name = 'git_commit';

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

            const message = args.message ? String(args.message) : undefined;
            if (!message) {
                return { success: false, output: '', error: 'MISSING_MESSAGE: commit message is required' };
            }

            const signoff = Boolean(args.signoff);

            // Check if there are staged changes via the VS Code Git API
            const apiStagedChanges = (repo.state.changes ?? []).filter((c: GitChange) => {
                const group = c.resourceGroup;
                return group && (group.id === 'index-modified' || group.id === 'index-deleted' ||
                    group.id === 'index-renamed' || group.id === 'index-added');
            });

            // If the API sees no staged changes, verify via shell because files
            // may have been staged externally (e.g. `git add` in a terminal).
            let hasStaged = apiStagedChanges.length > 0;
            let shellStagedCount = 0;

            if (!hasStaged) {
                try {
                    const { runGitCommand } = await import('../gitCommandRunner');
                    const listed = await runGitCommand(cached.rootPath, 'diff --cached --name-only');
                    const files = listed.split('\n').filter(Boolean);
                    shellStagedCount = files.length;
                    hasStaged = shellStagedCount > 0;
                } catch {
                    // Could not run shell check — trust the API result (no staged changes)
                }
            }

            if (!hasStaged) {
                return { success: false, output: '', error: 'NOTHING_TO_COMMIT: no staged changes found' };
            }

            // Build the final commit message
            let commitMessage = message;
            if (signoff) {
                const signer = await getSignerIdentity(cached.rootPath);
                if (signer) {
                    commitMessage += `\n\nSigned-off-by: ${signer.name} <${signer.email}>`;
                }
            }

            // Try VS Code Git API first; fall back to shell if the API
            // cannot see the staged changes (external staging mismatch).
            let commitResult: string | undefined;

            if (apiStagedChanges.length > 0) {
                // API sees staged changes — use the API
                commitResult = await repo.commit(commitMessage, {
                    all: false,
                });
            } else {
                // Shell sees staged changes but API does not — use shell commit.
                // Write the message to a temp file to avoid shell quoting issues
                // with custom git aliases that misinterpret -m arguments.
                const { runGitCommand } = await import('../gitCommandRunner');
                const crypto = await import('crypto');
                const fs = await import('fs');
                const path = await import('path');
                const os = await import('os');

                const msgFile = path.join(os.tmpdir(), `codeon-commit-msg-${crypto.randomUUID()}.txt`);
                try {
                    fs.writeFileSync(msgFile, commitMessage, 'utf8');
                    // Use array args to avoid Windows quoting issues with -F <path>
                    await runGitCommand(cached.rootPath, ['commit', '-F', msgFile]);
                    // Retrieve the commit hash
                    const head = await runGitCommand(cached.rootPath, 'rev-parse HEAD');
                    commitResult = head.trim();
                } finally {
                    try { fs.unlinkSync(msgFile); } catch { /* best effort cleanup */ }
                }
            }

            const head = repo.state.HEAD;
            const branchName = head?.name ?? '(detached)';
            const filesStaged = apiStagedChanges.length > 0 ? apiStagedChanges.length : shellStagedCount;

            const output = {
                action: 'commit',
                repository: cached.rootPath,
                branch: branchName,
                hash: typeof commitResult === 'string' ? commitResult : undefined,
                message,
                signoff,
                filesStaged,
            };

            return { success: true, output: JSON.stringify(output, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

async function getSignerIdentity(cwd: string): Promise<{ name: string; email: string } | null> {
    try {
        const { runGitCommand } = await import('../gitCommandRunner');
        const nameRaw = (await runGitCommand(cwd, 'config user.name')).trim();
        const emailRaw = (await runGitCommand(cwd, 'config user.email')).trim();
        if (nameRaw && emailRaw) {
            return { name: nameRaw, email: emailRaw };
        }
    } catch {
        // Could not read git config
    }
    return null;
}
