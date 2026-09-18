import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot, resolveWorkspacePath } from '../pathSafety';
import { getCachedGitRepository, refreshGitRepositoryState } from '../gitRepositoryCache';

/**
 * git_blame tool (Phase 4, R0).
 * Returns line-level attribution for a file using `git blame -p`.
 */
export class GitBlameExecutor implements ToolExecutor {
    public name = 'git_blame';

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

            const relPath = args.path ? String(args.path) : undefined;
            if (!relPath) {
                return { success: false, output: '', error: 'MISSING_PATH: path is required for git_blame' };
            }

            const startLine = args.startLine !== undefined ? Math.max(1, Number(args.startLine)) : undefined;
            const endLine = args.endLine !== undefined ? Math.max(1, Number(args.endLine)) : undefined;

            // Resolve the path
            const workspaceRoot = getWorkspaceRoot();
            const absPath = resolveWorkspacePath(relPath, workspaceRoot);
            const repoRelative = toRepoRelative(cached.rootPath, absPath);

            // Build range argument
            let rangeArg = '';
            if (startLine && endLine) {
                rangeArg = `${startLine},${endLine - startLine + 1}`;
            } else if (startLine) {
                rangeArg = `${startLine},`;
            }

            // Run git blame -p for porcelain output
            const blameArgs = rangeArg ? `blame -p -L ${rangeArg} ${repoRelative}` : `blame -p ${repoRelative}`;
            const { runGitCommand } = await import('../gitCommandRunner');
            const rawOutput = await runGitCommand(cached.rootPath, blameArgs);

            // Parse porcelain format — stream-parse line by line instead of split('\n\n')
            const lines = parseBlamePorcelain(rawOutput);

            const output = {
                repository: cached.rootPath,
                path: relPath,
                startLine: startLine ?? 1,
                endLine: endLine ?? lines.length,
                totalLines: lines.length,
                lines,
            };

            return { success: true, output: JSON.stringify(output, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

interface BlameLine {
    lineNumber: number;
    originalLineNumber?: number;
    commitHash: string;
    author: string;
    authorDate: string;
    summary: string;
    text: string;
}

/**
 * Stream-parse blame porcelain output line-by-line.
 * Avoids materializing the entire output into an array via split('\n\n').
 */
function parseBlamePorcelain(raw: string): BlameLine[] {
    const lines: BlameLine[] = [];
    const allLines = raw.split('\n');
    let i = 0;

    while (i < allLines.length) {
        // Skip blank separator lines between entries
        if (allLines[i].trim() === '') { i++; continue; }

        // First line: header "commit <hash>"
        if (!allLines[i]?.startsWith('commit ')) { i++; continue; }
        const commitHash = allLines[i].slice(7).trim();
        i++;

        let author = '';
        let authorDate = '';
        let originalLineNum: number | undefined;
        let finalLineNum: number | undefined;
        let summary = '';

        // Parse header fields
        while (i < allLines.length && !allLines[i].startsWith('\t')) {
            const line = allLines[i];
            if (line.startsWith('author ')) {
                author = line.slice(7).trim();
            } else if (line.startsWith('author-time ')) {
                const ts = parseInt(line.slice(12).trim(), 10);
                authorDate = new Date(ts * 1000).toISOString();
            } else if (line.startsWith('line ')) {
                finalLineNum = parseInt(line.slice(5).trim(), 10);
            } else if (line.startsWith('orig-line ')) {
                originalLineNum = parseInt(line.slice(10).trim(), 10);
            }
            i++;
        }

        // Remaining lines are the content (tab-prefixed)
        const textLines: string[] = [];
        while (i < allLines.length && allLines[i].startsWith('\t')) {
            textLines.push(allLines[i].slice(1));
            i++;
        }

        // Check for a summary line (non-tab, non-blank after headers but before next entry)
        if (i < allLines.length && !allLines[i].startsWith('\t') && allLines[i].trim() !== '' &&
            !allLines[i].startsWith('commit ')) {
            summary = allLines[i].trim();
            i++;
        }

        const text = textLines.join('\n');

        lines.push({
            lineNumber: finalLineNum ?? lines.length + 1,
            originalLineNumber: originalLineNum,
            commitHash,
            author,
            authorDate,
            summary,
            text,
        });
    }

    return lines;
}

function toRepoRelative(repoRoot: string, absPath: string): string {
    const sep = require('path').sep;
    const rootSep = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep;
    if (absPath.startsWith(rootSep)) {
        return absPath.slice(rootSep.length);
    }
    return absPath;
}
