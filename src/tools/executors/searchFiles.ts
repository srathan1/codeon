import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot } from '../pathSafety';

export class SearchFilesExecutor implements ToolExecutor {
    public name = 'search_files';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const relPath = String(args.path || '.');
            const pattern = String(args.pattern || '');
            const filePattern = args.filePattern ? String(args.filePattern) : undefined;
            const maxResults = args.maxResults !== undefined ? Number(args.maxResults) : 100;

            const workspaceRoot = getWorkspaceRoot();
            const root = resolveWorkspacePath(relPath, workspaceRoot);

            // P6-T2: compile with the global flag so exec() advances through the
            // text via lastIndex. A non-global regex ignores lastIndex and would
            // re-match the first occurrence forever (duplicate-spam bug).
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, 'g');
            } catch (e) {
                return { success: false, output: '', error: `INVALID_REGEX: ${(e as Error).message}` };
            }

            // P6-T6: build a real matcher from the optional file-name glob rather
            // than the old `includes(filePattern.replace('*',''))` (which only
            // stripped the first '*' and substring-matched, so `*.ts` also matched
            // `.tsx`/`.ts.bak`).
            const fileMatcher = filePattern ? compileFileGlob(filePattern) : undefined;

            const matches: string[] = [];

            try {
                const stat = fs.statSync(root);
                if (stat.isFile()) {
                    this.searchFile(root, regex, fileMatcher, maxResults, matches, workspaceRoot);
                } else {
                    this.walkDirectory(root, regex, fileMatcher, maxResults, matches, workspaceRoot);
                }
            } catch (e: unknown) {
                const err = e as NodeJS.ErrnoException;
                if (err.code === 'ENOTDIR' || err.code === 'ENOENT') {
                    const parentDir = path.dirname(root);
                    const suggestedName = path.basename(root);
                    if (fs.existsSync(parentDir)) {
                        this.walkDirectory(parentDir, regex, compileFileGlob(suggestedName), maxResults, matches, workspaceRoot);
                    } else {
                        return { success: false, output: '', error: `PATH_NOT_FOUND: '${relPath}' does not exist. Use list_dir to find the correct path.` };
                    }
                } else {
                    throw e;
                }
            }

            let output = matches.join('\n');
            if (matches.length >= maxResults) {
                output += `\n\n... [truncated at ${maxResults} results — use maxResults to paginate]`;
            }

            return { success: true, output };
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('PATH_TRAVERSAL') || err.message.includes('SYMLINK_ESCAPE') || err.message.includes('escapes workspace')) {
                return { success: false, output: '', error: err.message };
            }
            return { success: false, output: '', error: err.message };
        }
    }

    /**
     * Collect every regex match in one file's text (P6-T2/T3). Shared by the
     * single-file and directory-walk paths so they can't diverge. Advances via
     * the global regex's lastIndex and guards against zero-width matches so a
     * pattern like `a*` can't loop forever.
     */
    private collectMatches(
        text: string, regex: RegExp, filePath: string,
        maxResults: number, matches: string[], workspaceRoot: string,
    ): void {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while (matches.length < maxResults && (match = regex.exec(text)) !== null) {
            const line = text.slice(0, match.index).split('\n').length;
            matches.push(`Line ${line} in ${path.relative(workspaceRoot, filePath)}: ${match[0]}`);
            // Avoid an infinite loop on zero-width matches.
            if (match.index === regex.lastIndex) {
                regex.lastIndex++;
            }
        }
    }

    /** Search a single file for regex matches. */
    private searchFile(
        filePath: string, regex: RegExp, fileMatcher: ((name: string) => boolean) | undefined,
        maxResults: number, matches: string[], workspaceRoot: string,
    ): void {
        if (matches.length >= maxResults) return;
        if (fileMatcher && !fileMatcher(path.basename(filePath))) return;
        try {
            const text = fs.readFileSync(filePath, 'utf8');
            this.collectMatches(text, regex, filePath, maxResults, matches, workspaceRoot);
        } catch { /* skip unreadable */ }
    }

    /** Recursively walk a directory searching files for regex matches. */
    private walkDirectory(
        dir: string, regex: RegExp, fileMatcher: ((name: string) => boolean) | undefined,
        maxResults: number, matches: string[], workspaceRoot: string,
    ): void {
        if (matches.length >= maxResults) return;
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (matches.length >= maxResults) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git') continue;
                this.walkDirectory(full, regex, fileMatcher, maxResults, matches, workspaceRoot);
            } else if (!fileMatcher || fileMatcher(entry.name)) {
                try {
                    const text = fs.readFileSync(full, 'utf8');
                    // P6-T3: collect ALL matches in the file, not just the first.
                    this.collectMatches(text, regex, full, maxResults, matches, workspaceRoot);
                } catch { /* skip unreadable */ }
            }
        }
    }
}

/**
 * Compile a simple filename glob (`*`, `?`) into a full-match predicate.
 * Anchored so `*.ts` matches `foo.ts` but not `foo.tsx` or `foo.ts.bak`.
 */
function compileFileGlob(glob: string): (name: string) => boolean {
    const regexStr = '^' + glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (leave * and ?)
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') + '$';
    let re: RegExp;
    try {
        re = new RegExp(regexStr, 'i');
    } catch {
        // Fall back to a literal, case-insensitive substring test if the glob
        // produced an invalid regex.
        const lower = glob.toLowerCase();
        return (name: string) => name.toLowerCase().includes(lower);
    }
    return (name: string) => re.test(name);
}
