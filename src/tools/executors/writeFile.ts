import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, isProtectedPath } from '../pathSafety';
import { checkFileStale, atomicWrite, hashContent, countLineDiff } from '../fileVersion';

export class WriteFileExecutor implements ToolExecutor {
    public name = 'write_file';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            let relPath = String(args.path || args.file_path || args.filePath || '').trim();
            let content = String(args.content || '');

            // Defensive: if content arrived as a JSON-encoded string (with quotes), decode it
            if (typeof content === 'string' && content.startsWith('"') && content.endsWith('"') && content.length > 1) {
                try { content = JSON.parse(content); } catch {}
            }

            const overwrite = args.overwrite !== false; // default true — users almost always want to overwrite
            const expectedVersion = args.expectedVersion ? String(args.expectedVersion) : undefined;

            const workspaceRoot = getWorkspaceRoot();
            const target = resolveWorkspacePath(relPath, workspaceRoot);

            // Check protected paths
            if (isProtectedPath(target)) {
                return { success: false, output: '', error: `PROTECTED_PATH: ${relPath}` };
            }

            const exists = fs.existsSync(target);

            // Overwrite protection (only when explicitly disabled)
            if (exists && !overwrite) {
                return {
                    success: false,
                    output: '',
                    error: `FILE_ALREADY_EXISTS: ${relPath}. Set overwrite=true to replace.`,
                };
            }

            // Stale file check for existing files
            if (exists && expectedVersion) {
                const staleCheck = checkFileStale(target, expectedVersion);
                if (staleCheck.stale) {
                    return { success: false, output: '', error: staleCheck.reason ?? 'STALE_FILE_VERSION' };
                }
            }

            // Ensure parent directory exists
            fs.mkdirSync(path.dirname(target), { recursive: true });

            const oldContent = exists ? fs.readFileSync(target, 'utf8') : '';
            const beforeHash = oldContent ? hashContent(oldContent) : '(new file)';

            // Write atomically
            atomicWrite(target, content);

            const afterHash = hashContent(content);

            const unifiedDiff = createTwoFilesPatch(
                relPath,
                relPath,
                oldContent,
                content,
                '(original)',
                '(modified)'
            );

            // Open in editor for new files
            if (!exists) {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
            }

            const action = exists ? 'overwritten' : 'created';
            const { added, removed } = countLineDiff(oldContent, content);
            const diffSummary = exists ? `+${added} -${removed}` : `+${added} (new file)`;
            return {
                success: true,
                output: `File ${action}: ${relPath} (${diffSummary})\n\nBefore hash: ${beforeHash}\nAfter hash: ${afterHash}\n\n${unifiedDiff}`,
            };
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('PATH_TRAVERSAL') || err.message.includes('SYMLINK_ESCAPE')) {
                return { success: false, output: '', error: err.message };
            }
            return { success: false, output: '', error: err.message };
        }
    }
}
