import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot } from '../pathSafety';

export class GlobFilesExecutor implements ToolExecutor {
    public name = 'glob_files';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const patternsStr = String(args.patterns || '');
            const basePath = args.basePath ? String(args.basePath) : '.';
            const excludePatterns = args.excludePatterns ? String(args.excludePatterns).split(',').map((s: string) => s.trim()) : [];
            const maxResults = args.maxResults !== undefined ? Number(args.maxResults) : 100;

            const workspaceRoot = getWorkspaceRoot();
            const searchRoot = resolveWorkspacePath(basePath, workspaceRoot);

            const patterns = patternsStr.split(',').map((s: string) => s.trim());
            const results: string[] = [];

            for (const pattern of patterns) {
                // Simple glob implementation supporting ** and *
                const walk = (dir: string) => {
                    if (results.length >= maxResults) return;
                    if (!fs.existsSync(dir)) return;
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (results.length >= maxResults) return;
                        const full = path.join(dir, entry.name);
                        const rel = path.relative(workspaceRoot, full);

                        // Check exclude patterns
                        if (excludePatterns.some(ep => rel.includes(ep))) continue;

                        if (entry.isDirectory()) {
                            // Skip node_modules, .git
                            if (entry.name === 'node_modules' || entry.name === '.git') continue;
                            walk(full);
                        } else {
                            // P6-T7: a pattern with a '/' (e.g. `src/**/*.ts`) is
                            // matched against the path relative to the search root;
                            // a bare pattern (e.g. `*.ts`) matches the basename in
                            // any subdirectory (recursive), preserving prior behavior.
                            const relToBase = path.relative(searchRoot, full).split(path.sep).join('/');
                            const target = pattern.includes('/') ? relToBase : entry.name;
                            if (matchesGlob(target, pattern)) {
                                results.push(rel);
                            }
                        }
                    }
                };

                walk(searchRoot);
            }

            let output = JSON.stringify(results, null, 2);
            if (results.length >= maxResults) {
                output += `\n... [truncated at ${maxResults} results]`;
            }

            return { success: true, output };
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('PATH_TRAVERSAL') || err.message.includes('SYMLINK_ESCAPE')) {
                return { success: false, output: '', error: err.message };
            }
            return { success: false, output: '', error: err.message };
        }
    }
}

/**
 * Glob matcher supporting a single star (within a path segment), a double star
 * (any number of segments), and `?`. Full-path directory-qualified patterns are
 * supported (P6-T7) — matched against the target's workspace-relative path.
 */
function matchesGlob(target: string, pattern: string): boolean {
    return globToRegex(pattern).test(target);
}

function globToRegex(pattern: string): RegExp {
    // Escape regex specials (leave * and ? for glob handling).
    const regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        // Globstar-with-slash matches any number of leading directories
        // (including none); a bare globstar matches across segments.
        .replace(/\*\*\//g, '___GLOBSTAR_SLASH___')
        .replace(/\*\*/g, '___GLOBSTAR___')
        .replace(/\*/g, '[^/]*')
        // Handle the pattern's own `?` BEFORE expanding placeholders, otherwise
        // the `?` characters inside the expanded `(?:.*/)?` would be clobbered.
        .replace(/\?/g, '[^/]')
        .replace(/___GLOBSTAR_SLASH___/g, '(?:.*/)?')
        .replace(/___GLOBSTAR___/g, '.*');
    return new RegExp('^' + regex + '$');
}
