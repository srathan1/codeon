import * as vscode from 'vscode';
import * as fs from 'fs';
import { createTwoFilesPatch } from 'diff';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, isProtectedPath } from '../pathSafety';
import { checkFileStale, hashContent, countLineDiff, verifyUnchangedSince } from '../fileVersion';

export class EditFileExecutor implements ToolExecutor {
    public name = 'edit_file';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const relPath = String(args.path || '');
            const oldText = String(args.oldText || '');
            const newText = String(args.newText || '');
            const replaceAll = args.replaceAll === true;
            const expectedVersion = args.expectedVersion ? String(args.expectedVersion) : undefined;

            const workspaceRoot = getWorkspaceRoot();
            const target = resolveWorkspacePath(relPath, workspaceRoot);

            // Check protected paths
            if (isProtectedPath(target)) {
                return { success: false, output: '', error: `PROTECTED_PATH: ${relPath}` };
            }

            if (!fs.existsSync(target)) {
                return { success: false, output: '', error: `FILE_NOT_FOUND: ${relPath}` };
            }

            // Stale file check
            if (expectedVersion) {
                const staleCheck = checkFileStale(target, expectedVersion);
                if (staleCheck.stale) {
                    return { success: false, output: '', error: staleCheck.reason ?? 'STALE_FILE_VERSION' };
                }
            }

            let content = fs.readFileSync(target, 'utf8');

            // Find all occurrences of oldText
            const indices: number[] = [];
            let searchFrom = 0;
            while (true) {
                const idx = content.indexOf(oldText, searchFrom);
                if (idx === -1) break;
                indices.push(idx);
                searchFrom = idx + 1;
            }

            if (indices.length === 0) {
                return { success: false, output: '', error: `NO_MATCH: '${oldText.slice(0, 50)}...' not found in ${relPath}` };
            }

            if (indices.length > 1 && !replaceAll) {
                // Ambiguous match — report line numbers
                const lines = indices.map(i => {
                    const lineNum = content.slice(0, i).split('\n').length;
                    return lineNum;
                });
                return {
                    success: false,
                    output: '',
                    error: `AMBIGUOUS_MATCH: '${oldText.slice(0, 50)}...' found ${indices.length} times at lines [${lines.join(', ')}]. Use replaceAll=true to replace all.`,
                };
            }

            const beforeHash = hashContent(content);

            // Apply replacements
            let newContent: string;
            if (replaceAll) {
                newContent = content.split(oldText).join(newText);
            } else {
                const idx = indices[0];
                newContent = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
            }

            const afterHash = hashContent(newContent);

            const unifiedDiff = createTwoFilesPatch(
                relPath,
                relPath,
                content,
                newContent,
                '(original)',
                '(modified)'
            );

            // P5-T7: re-verify the file hasn't changed on disk since we read it
            // above (line: content = readFileSync). The edit `newContent` was
            // computed against `content`; if an external process rewrote the file
            // in between, applying our edit would silently discard that change.
            const freshness = verifyUnchangedSince(target, beforeHash);
            if (!freshness.ok) {
                return { success: false, output: '', error: freshness.reason ?? 'STALE_FILE_VERSION' };
            }

            // Apply via VS Code WorkspaceEdit for undo support.
            // L-10: replace only the matched range(s) rather than the whole
            // document. A full-document replace makes every edit — even a
            // one-word change in a large file — show up as a single
            // document-wide diff in the editor's undo stack and forces VS
            // Code to re-diff/re-render the entire file, plus it collapses
            // the user's cursor/selection/scroll position on every edit.
            // Targeted ranges keep undo granular and avoid that cost.
            const document = await vscode.workspace.openTextDocument(target);
            const edit = new vscode.WorkspaceEdit();
            if (document.getText() === content) {
                // Offsets are computed against `content` (the fs.readFileSync
                // result); only valid if the open document's text matches it
                // exactly (e.g. no EOL normalization on load).
                for (const idx of replaceAll ? indices : [indices[0]]) {
                    const range = new vscode.Range(
                        document.positionAt(idx),
                        document.positionAt(idx + oldText.length)
                    );
                    edit.replace(document.uri, range, newText);
                }
            } else {
                // Document text diverged from what we read from disk (e.g.
                // EOL normalization) — offsets from `content` wouldn't line
                // up, so fall back to a full-range replace to stay correct.
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                );
                edit.replace(document.uri, fullRange, newContent);
            }

            const success = await vscode.workspace.applyEdit(edit);
            if (!success) {
                return { success: false, output: '', error: `Failed to apply edit to ${relPath}` };
            }

            await document.save();

            const { added, removed } = countLineDiff(content, newContent);
            const diffSummary = `+${added} -${removed}`;
            return {
                success: true,
                output: `Edited ${relPath} (${indices.length} replacement${indices.length > 1 ? 's' : ''}, ${diffSummary})\n\nBefore hash: ${beforeHash}\nAfter hash: ${afterHash}\n\n${unifiedDiff}`,
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
