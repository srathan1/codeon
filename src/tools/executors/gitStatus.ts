import * as path from 'path';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getCachedGitRepository, refreshGitRepositoryState } from '../gitRepositoryCache';

/* ------------------------------------------------------------------ */
/*  Local shapes for VS Code Git extension types (untyped in strict)  */
/* ------------------------------------------------------------------ */

interface GitRef {
    type: string;
    name?: string;
    upstream?: string;
    commit?: unknown;
}

interface GitUpstream {
    remote: string;
    name: string;
}

interface GitHEAD {
    name?: string;
    label?: string;
    upstream?: GitUpstream;
}

interface GitResourceGroup {
    id: string;
}

interface GitChange {
    uri?: { fsPath: string };
    type: string;
    resourceGroup?: GitResourceGroup;
    resourceGroups?: GitResourceGroup[];
    rename?: { _old?: { fsPath: string } };
}

interface GitMergeChange {
    base?: { uri?: { fsPath: string } };
}

interface GitWorkingTreeState {
    refs?: GitRef[];
    HEAD?: GitHEAD;
    changes?: GitChange[];
    mergeChanges?: GitMergeChange[];
}

interface GitRepository {
    state: GitWorkingTreeState;
}

/* ------------------------------------------------------------------ */

/**
 * git_status tool (Phase 4, R0).
 * Returns branch name, ahead/behind counts, and categorized file states
 * (staged, unstaged, untracked, conflicted) using VS Code's Git API.
 */
export class GitStatusExecutor implements ToolExecutor {
    public name = 'git_status';

    public async execute(_args: Record<string, unknown>): Promise<ToolResult> {
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

            const workingTreeState = repo.state;

            // Resolve branch name and upstream info
            let branchName = '';
            let ahead = 0;
            let behind = 0;
            const heads = workingTreeState.refs?.filter((r) => r.type === 'head') ?? [];
            const activeHead = heads.find((r) => r.name && (!r.upstream ? false : r.name)) ?? heads[0];

            // Try to get the current branch from the repository UI element
            if (repo.state.HEAD) {
                branchName = repo.state.HEAD.name ?? repo.state.HEAD.label ?? '(detached)';
            } else if (activeHead?.name) {
                branchName = activeHead.name;
            }

            // Compute ahead/behind from upstream comparison
            if (repo.state.HEAD?.upstream) {
                try {
                    const upstream = repo.state.HEAD.upstream;
                    const base = `${upstream.remote}/${upstream.name}`;
                    const { runGitCommand } = await import('../gitCommandRunner');
                    const result = await runGitCommand(cached.rootPath, `rev-list --count --left-right ${branchName}...${base}`);
                    const parts = result.trim().split('\t');
                    if (parts.length === 2) {
                        ahead = parseInt(parts[0], 10) || 0;
                        behind = parseInt(parts[1], 10) || 0;
                    }
                } catch {
                    // Could not compute ahead/behind — leave defaults
                }
            }

            // Categorize changes
            const staged: string[] = [];
            const unstaged: string[] = [];
            const untracked: string[] = [];
            const conflicted: string[] = [];

            for (const change of workingTreeState.changes ?? []) {
                const filePath = change.uri?.fsPath ?? '';
                const relPath = pathToRepoRelative(cached.rootPath, filePath);
                const type = change.type;

                if (type === 'deleted' || type === 'modified' || type === 'intended' || type === 'renamed' || type === 'ignored') {
                    // These are tracked changes — check stage via resourceGroup
                    if (isStagedChange(change)) {
                        staged.push(formatChange(relPath, change));
                    } else {
                        unstaged.push(formatChange(relPath, change));
                    }
                } else if (type === 'untracked' || type === 'unknown') {
                    untracked.push(relPath);
                }

                // Check for conflict markers in resource group
                if (change.resourceGroups?.some((g) => g.id === 'merge-conflict')) {
                    conflicted.push(relPath);
                }
            }

            // Also check workingTreeState for merge/conflict state
            const hasMerge = (workingTreeState.mergeChanges?.length ?? 0) > 0;
            for (const mc of workingTreeState.mergeChanges ?? []) {
                const relPath = pathToRepoRelative(cached.rootPath, mc.base?.uri?.fsPath ?? '');
                if (relPath && !conflicted.includes(relPath)) {
                    conflicted.push(relPath);
                }
            }

            const status = {
                repository: cached.rootPath,
                branch: branchName,
                upstream: repo.state.HEAD?.upstream ? `${repo.state.HEAD.upstream.remote}/${repo.state.HEAD.upstream.name}` : null,
                ahead,
                behind,
                isMergeCommit: hasMerge,
                staged,
                unstaged,
                untracked,
                conflicted,
                summary: {
                    stagedCount: staged.length,
                    unstagedCount: unstaged.length,
                    untrackedCount: untracked.length,
                    conflictedCount: conflicted.length,
                },
            };

            return { success: true, output: JSON.stringify(status, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

function isStagedChange(change: GitChange): boolean {
    // In VS Code Git API, staged items appear in resourceGroup with specific ids
    const group = change.resourceGroup;
    if (group) {
        return group.id === 'index-modified' || group.id === 'index-deleted' ||
               group.id === 'index-renamed' || group.id === 'index-added';
    }
    // Fallback: check if it's in the index changes array
    return false;
}

function formatChange(relPath: string, change: GitChange): string {
    const op = change.type === 'renamed' ? `renamed(${change.rename?._old?.fsPath ?? ''}→${relPath})` :
               change.type === 'deleted' ? `deleted` :
               change.type === 'intended' ? `intended` :
               change.type ?? 'modified';
    return `${op}: ${relPath}`;
}

function pathToRepoRelative(repoRoot: string, absPath: string): string {
    if (!absPath) return '';
    const rootSep = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
    if (absPath.startsWith(rootSep)) {
        return absPath.slice(rootSep.length);
    }
    if (absPath === repoRoot) return '.';
    return absPath;
}
