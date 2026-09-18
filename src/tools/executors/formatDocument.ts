import * as vscode from 'vscode';
import { createTwoFilesPatch } from 'diff';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, toWorkspaceRelative, isProtectedPath } from '../pathSafety';

export class FormatDocumentExecutor implements ToolExecutor {
    public name = 'format_document';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const relPath = String(args.path || '');
            const startLine = args.startLine !== undefined ? Number(args.startLine) : undefined;
            const endLine = args.endLine !== undefined ? Number(args.endLine) : undefined;
            const previewOnly = args.previewOnly === true;

            const workspaceRoot = getWorkspaceRoot();
            const absPath = resolveWorkspacePath(relPath, workspaceRoot);

            if (isProtectedPath(absPath)) {
                return { success: false, output: '', error: 'PROTECTED_PATH: cannot format protected file' };
            }

            // Open the document
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));

            // Determine formatting range
            let formatRange: vscode.Range | undefined;
            if (startLine !== undefined && endLine !== undefined) {
                const sLine = Math.max(0, startLine);
                const eLine = Math.min(doc.lineCount - 1, endLine);
                formatRange = new vscode.Range(
                    new vscode.Position(sLine, 0),
                    new vscode.Position(eLine, doc.lineAt(eLine).text.length),
                );
            }

            // Get formatting edits
            let edits: vscode.TextEdit[] = [];
            if (formatRange) {
                edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
                    'vscode.executeDocumentRangeFormattingProvider',
                    doc.uri,
                    formatRange,
                );
            } else {
                edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
                    'vscode.executeDocumentFormattingEdits',
                    doc.uri,
                );
            }

            if (!edits || edits.length === 0) {
                return {
                    success: true,
                    output: JSON.stringify({
                        file: relPath,
                        formatted: false,
                        message: 'No formatting changes needed.',
                    }, null, 2),
                };
            }

            // Build the formatted text by applying edits to original content
            const originalText = doc.getText();
            const newText = applyTextEdits(originalText, edits);

            // Generate diff
            const diff = createTwoFilesPatch(
                relPath,
                relPath + ' (formatted)',
                originalText,
                newText,
                'original',
                'formatted',
            );

            // Build edit summary
            const editSummary = edits.map(e => ({
                range: {
                    startLine: e.range.start.line + 1,
                    endLine: e.range.end.line + 1,
                },
                changeLength: e.newText.length,
            }));

            const result: Record<string, unknown> = {
                file: relPath,
                formatted: true,
                editsApplied: edits.length,
                previewOnly,
                edits: editSummary,
            };

            // Apply formatting if not preview-only
            if (!previewOnly) {
                const workspaceEdit = new vscode.WorkspaceEdit();
                workspaceEdit.set(doc.uri, edits);
                await vscode.workspace.applyEdit(workspaceEdit);
                result.applied = true;
            }

            if (diff) {
                result.diff = diff;
            }

            return { success: true, output: JSON.stringify(result, null, 2) };
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('PATH_TRAVERSAL') || err.message.includes('SYMLINK_ESCAPE')) {
                return { success: false, output: '', error: err.message };
            }
            return { success: false, output: '', error: err.message };
        }
    }
}

/** Apply an array of TextEdits to a string in reverse order (to preserve offsets). */
function applyTextEdits(text: string, edits: vscode.TextEdit[]): string {
    // Sort edits in reverse order so earlier offsets remain valid
    const sorted = [...edits].sort((a, b) => {
        return b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character;
    });

    let result = text;
    for (const edit of sorted) {
        const startPos = offsetAt(edit.range.start, text);
        const endPos = offsetAt(edit.range.end, text);
        result = result.slice(0, startPos) + edit.newText + result.slice(endPos);
    }
    return result;
}

/** Convert a Position to a character offset in the given text. */
function offsetAt(pos: vscode.Position, text: string): number {
    let offset = 0;
    for (let i = 0; i < pos.line; i++) {
        const lineStart = text.indexOf('\n', offset);
        if (lineStart === -1) return offset + pos.character;
        offset = lineStart + 1;
    }
    // Handle \r\n
    if (text[offset] === '\r') offset += 1;
    return offset + pos.character;
}
