import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, isProtectedPath } from '../pathSafety';
import { checkFileStale, atomicWrite, hashContent, countLineDiff } from '../fileVersion';

export class ApplyPatchExecutor implements ToolExecutor {
    public name = 'apply_patch';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const relPath = String(args.path || '');
            const newContent = String(args.content || '');
            const expectedVersion = args.expectedVersion ? String(args.expectedVersion) : undefined;

            const workspaceRoot = getWorkspaceRoot();
            const target = resolveWorkspacePath(relPath, workspaceRoot);

            // Check protected paths
            if (isProtectedPath(target)) {
                return { success: false, output: '', error: `PROTECTED_PATH: ${relPath} matches a protected/sensitive pattern` };
            }

            const exists = fs.existsSync(target);

            // Stale file check for existing files
            if (exists && (expectedVersion !== undefined)) {
                const staleCheck = checkFileStale(target, expectedVersion);
                if (staleCheck.stale) {
                    return { success: false, output: '', error: staleCheck.reason ?? 'STALE_FILE_VERSION' };
                }
            }

            const oldContent = exists ? fs.readFileSync(target, 'utf8') : '';
            const beforeHash = hashContent(oldContent);

            const unifiedDiff = createTwoFilesPatch(
                path.relative(workspaceRoot, target),
                path.relative(workspaceRoot, target),
                oldContent,
                newContent,
                '(original)',
                '(modified)'
            );

            // Ensure parent directory exists
            fs.mkdirSync(path.dirname(target), { recursive: true });

            if (!exists) {
                // New file — use atomic write
                atomicWrite(target, newContent);
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));

                const afterHash = hashContent(newContent);
                const { added } = countLineDiff(oldContent, newContent);
                return {
                    success: true,
                    output: `File created: ${relPath} (+${added})\n\nBefore hash: (new file)\nAfter hash: ${afterHash}\n\n${unifiedDiff}`,
                };
            }

            // Existing file — use VS Code WorkspaceEdit for undo support
            const document = await vscode.workspace.openTextDocument(target);
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                document.positionAt(0),
                document.positionAt(document.getText().length)
            );
            edit.replace(document.uri, fullRange, newContent);

            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                return { success: false, output: '', error: `Failed to apply edit to ${relPath}` };
            }

            await document.save();

            const { added, removed } = countLineDiff(oldContent, newContent);
            const diffSummary = `+${added} -${removed}`;
            const afterHash = hashContent(newContent);
            return {
                success: true,
                output: `File updated: ${relPath} (${diffSummary})\n\nBefore hash: ${beforeHash}\nAfter hash: ${afterHash}\n\n${unifiedDiff}`,
            };
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('PATH_TRAVERSAL') || err.message.includes('SYMLINK_ESCAPE') || err.message.includes('escapes workspace')) {
                return { success: false, output: '', error: err.message };
            }
            return { success: false, output: '', error: err.message };
        }
    }
}
