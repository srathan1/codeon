import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getCachedGitRepository, refreshGitRepositoryState } from '../gitRepositoryCache';

/**
 * git_show tool (Phase 4, R0).
 * Shows a commit, tag, or file version at a given revision.
 */
export class GitShowExecutor implements ToolExecutor {
    public name = 'git_show';

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

            const revision = args.revision ? String(args.revision) : 'HEAD';
            const relPath = args.path ? String(args.path) : undefined;

            // Build command
            let gitArgs = `show ${revision}`;
            if (relPath) {
                gitArgs += ` -- ${relPath}`;
            }

            const { runGitCommand } = await import('../gitCommandRunner');
            const rawOutput = await runGitCommand(cached.rootPath, gitArgs);

            // Parse the output into structured data
            const parsed = parseShowOutput(rawOutput, revision, relPath);

            return { success: true, output: JSON.stringify(parsed, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

interface ShowResult {
    revision: string;
    path?: string;
    commit?: {
        hash: string;
        author: string;
        date: string;
        message: string;
    };
    tree?: {
        mode: string;
        type: string;
        object: string;
        size: number;
    }[];
    diff?: string;
}

function parseShowOutput(raw: string, revision: string, relPath?: string): ShowResult {
    const result: ShowResult = {
        revision,
        path: relPath,
    };

    const lines = raw.split('\n');
    const commitInfo: { hash: string; author: string; date: string; message: string } = {
        hash: '',
        author: '',
        date: '',
        message: '',
    };

    let inMessage = false;
    let messageLines: string[] = [];
    let diffStart = -1;
    const treeEntries: ShowResult['tree'] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('commit ')) {
            commitInfo.hash = line.slice(7).trim();
        } else if (line.startsWith('Author:')) {
            commitInfo.author = line.slice(7).trim();
        } else if (line.startsWith('Date:')) {
            commitInfo.date = line.slice(5).trim();
        } else if (line === '' && commitInfo.author && !inMessage) {
            inMessage = true;
        } else if (inMessage) {
            if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
                diffStart = i;
                break;
            }
            if (line.startsWith('mode') || line.startsWith('100')) {
                // Tree entry (for blob shows)
                const parts = line.split(/\s+/);
                if (parts.length >= 3) {
                    treeEntries.push({
                        mode: parts[0],
                        type: parts[1],
                        object: parts[2],
                        size: parseInt(parts[3] ?? '0', 10),
                    });
                }
                inMessage = false;
            } else if (line.trim() === '' && messageLines.length > 0) {
                // End of message block
            } else {
                messageLines.push(line);
            }
        }
    }

    commitInfo.message = messageLines.join('\n').trim();
    if (commitInfo.hash || commitInfo.author) {
        result.commit = commitInfo;
    }

    if (treeEntries.length > 0) {
        result.tree = treeEntries;
    }

    if (diffStart >= 0) {
        result.diff = lines.slice(diffStart).join('\n');
    }

    return result;
}
