import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getCachedGitRepository, refreshGitRepositoryState } from '../gitRepositoryCache';

/* ------------------------------------------------------------------ */
/*  Local shapes for VS Code Git extension types (untyped in strict)  */
/* ------------------------------------------------------------------ */

interface GitHEAD {
    name?: string;
}

interface GitWorkingTreeState {
    refs?: Array<{ name?: string }>;
    HEAD?: GitHEAD;
}

interface GitRepository {
    state: GitWorkingTreeState;
    checkout(branch: string): Promise<void>;
}

/* ------------------------------------------------------------------ */

/**
 * git_branch tool (Phase 4, R0/R2).
 * List, create, switch, or delete branches.
 */
export class GitBranchExecutor implements ToolExecutor {
    public name = 'git_branch';

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

            const operation = String(args.operation || 'list').toLowerCase();
            const branch = args.branch ? String(args.branch) : undefined;
            const startPoint = args.startPoint ? String(args.startPoint) : undefined;

            switch (operation) {
                case 'list':
                    return await this.listBranches(repo, cached.rootPath);
                case 'create':
                    return await this.createBranch(repo, cached.rootPath, branch, startPoint);
                case 'switch':
                case 'checkout':
                    return await this.switchBranch(repo, cached.rootPath, branch);
                case 'delete':
                    return await this.deleteBranch(cached.rootPath, branch);
                default:
                    return { success: false, output: '', error: `INVALID_OPERATION: '${operation}' — use 'list', 'create', 'switch', or 'delete'` };
            }
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }

    private async listBranches(repo: GitRepository, rootPath: string): Promise<ToolResult> {
        const currentHead = repo.state.HEAD?.name ?? '';

        // Use shell command for reliable branch listing with commit hashes
        try {
            const { runGitCommand } = await import('../gitCommandRunner');
            const rawOutput = await runGitCommand(rootPath, 'branch -v --no-color -a');
            const lines = rawOutput.split('\n').filter(l => l.trim());

            const localBranches: Array<{ name: string; commit?: string; isActive: boolean }> = [];
            const remoteBranches: Array<{ name: string; commit?: string }> = [];

            for (const line of lines) {
                const trimmed = line.trim();
                const isCurrent = trimmed.startsWith('*');
                const cleanLine = trimmed.replace(/^\*?\s*/, '');

                // Match: <hash> <branch-name>  <optional-message>
                const match = cleanLine.match(/^([0-9a-f]{7,40})\s+(.+?)(?:\s+|$)/);
                if (match) {
                    const [_, hash, branchName] = match;
                    if (branchName.includes('/')) {
                        remoteBranches.push({ name: branchName, commit: hash });
                    } else {
                        localBranches.push({ name: branchName, commit: hash, isActive: isCurrent });
                    }
                }
            }

            // Ensure current head is marked active
            for (const b of localBranches) {
                if (b.name === currentHead) b.isActive = true;
            }

            const output = {
                repository: rootPath,
                currentBranch: currentHead,
                localBranches,
                remoteBranches,
                totalLocal: localBranches.length,
                totalRemote: remoteBranches.length,
            };

            return { success: true, output: JSON.stringify(output, null, 2) };
        } catch {
            // Fallback: use API refs only (less detailed but available)
            const refs = repo.state.refs ?? [];
            const localBranches: Array<{ name: string; commit?: string; isActive: boolean }> = [];
            const remoteBranches: Array<{ name: string; commit?: string }> = [];

            for (const ref of refs) {
                const name = (ref as any).name ?? '';
                const type = (ref as any).type ?? '';
                if (type === 'remote') {
                    remoteBranches.push({ name });
                } else if (type === 'head' || type === 'local') {
                    localBranches.push({ name, isActive: name === currentHead });
                }
            }

            const output = {
                repository: rootPath,
                currentBranch: currentHead,
                localBranches,
                remoteBranches,
                totalLocal: localBranches.length,
                totalRemote: remoteBranches.length,
                note: 'API-only listing (git command unavailable)',
            };
            return { success: true, output: JSON.stringify(output, null, 2) };
        }
    }

    private async createBranch(repo: GitRepository, rootPath: string, branch?: string, startPoint?: string): Promise<ToolResult> {
        if (!branch) {
            return { success: false, output: '', error: 'MISSING_BRANCH: branch name is required for create operation' };
        }

        // Check if branch already exists via refs
        const existingRefs = repo.state.refs ?? [];
        const exists = existingRefs.some((r) => r.name === branch);
        if (exists) {
            return { success: false, output: '', error: `BRANCH_EXISTS: '${branch}' already exists` };
        }

        const startRef = startPoint || repo.state.HEAD?.name || 'HEAD';
        const { runGitCommand } = await import('../gitCommandRunner');
        await runGitCommand(rootPath, `branch ${branch} ${startRef}`);

        return {
            success: true,
            output: JSON.stringify({
                action: 'create',
                branch,
                startPoint: startRef,
                repository: rootPath,
            }, null, 2),
        };
    }

    private async switchBranch(repo: GitRepository, rootPath: string, branch?: string): Promise<ToolResult> {
        if (!branch) {
            return { success: false, output: '', error: 'MISSING_BRANCH: branch name is required for switch operation' };
        }

        const currentBranch = repo.state.HEAD?.name ?? '(unknown)';

        // Try using VS Code Git API first
        try {
            await repo.checkout(branch);
            return {
                success: true,
                output: JSON.stringify({
                    action: 'switch',
                    from: currentBranch,
                    to: branch,
                    repository: rootPath,
                }, null, 2),
            };
        } catch {
            // Fallback to git command
            try {
                const { runGitCommand } = await import('../gitCommandRunner');
                await runGitCommand(rootPath, `checkout ${branch}`);
                return {
                    success: true,
                    output: JSON.stringify({
                        action: 'switch',
                        from: currentBranch,
                        to: branch,
                        repository: rootPath,
                    }, null, 2),
                };
            } catch (e) {
                return { success: false, output: '', error: `CHECKOUT_FAILED: ${(e as Error).message}` };
            }
        }
    }

    private async deleteBranch(rootPath: string, branch?: string): Promise<ToolResult> {
        if (!branch) {
            return { success: false, output: '', error: 'MISSING_BRANCH: branch name is required for delete operation' };
        }

        try {
            const { runGitCommand } = await import('../gitCommandRunner');
            // Try safe delete first (-d), fall back to force (-D)
            await runGitCommand(rootPath, `branch -d ${branch}`);
        } catch {
            const { runGitCommand } = await import('../gitCommandRunner');
            await runGitCommand(rootPath, `branch -D ${branch}`);
        }

        return {
            success: true,
            output: JSON.stringify({
                action: 'delete',
                branch,
                repository: rootPath,
            }, null, 2),
        };
    }
}
