import * as vscode from 'vscode';
import { createTwoFilesPatch } from 'diff';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, toWorkspaceRelative, isProtectedPath } from '../pathSafety';

export class ApplyCodeActionExecutor implements ToolExecutor {
    public name = 'apply_code_action';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const relPath = String(args.path || '');
            const actionIndex = args.actionIndex !== undefined ? Number(args.actionIndex) : 0;
            const startLine = args.startLine !== undefined ? Number(args.startLine) : undefined;
            const endLine = args.endLine !== undefined ? Number(args.endLine) : undefined;
            const previewOnly = args.previewOnly === true;

            const workspaceRoot = getWorkspaceRoot();
            const absPath = resolveWorkspacePath(relPath, workspaceRoot);

            if (isProtectedPath(absPath)) {
                return { success: false, output: '', error: 'PROTECTED_PATH: cannot apply code actions on protected file' };
            }

            // Open the document
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));

            // Determine range
            let range: vscode.Range;
            if (startLine !== undefined && endLine !== undefined) {
                const sLine = Math.max(0, startLine);
                const eLine = Math.min(doc.lineCount - 1, endLine);
                range = new vscode.Range(
                    new vscode.Position(sLine, 0),
                    new vscode.Position(eLine, doc.lineAt(eLine).text.length),
                );
            } else if (startLine !== undefined) {
                const sLine = Math.max(0, startLine);
                range = new vscode.Range(
                    new vscode.Position(sLine, 0),
                    new vscode.Position(sLine, doc.lineAt(sLine).text.length),
                );
            } else {
                range = new vscode.Range(
                    new vscode.Position(0, 0),
                    new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length),
                );
            }

            // Re-fetch code actions for the same range
            const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(absPath));
            const rangeDiagnostics = diagnostics.filter(d => d.range.intersection(range) !== undefined);

            const context: vscode.CodeActionContext = {
                diagnostics: rangeDiagnostics,
                only: undefined,
                triggerKind: vscode.CodeActionTriggerKind.Invoke,
            };

            const rawActions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
                'vscode.executeCodeActionProvider',
                doc.uri,
                range,
                context,
            );

            if (!rawActions || rawActions.length === 0) {
                return {
                    success: false,
                    output: '',
                    error: 'NO_ACTIONS: no code actions found for the specified range. Run get_code_actions first.',
                };
            }

            if (actionIndex < 0 || actionIndex >= rawActions.length) {
                return {
                    success: false,
                    output: '',
                    error: `INVALID_INDEX: actionIndex ${actionIndex} is out of range [0, ${rawActions.length - 1}].`,
                };
            }

            const action = rawActions[actionIndex];
            if (!action) {
                return {
                    success: false,
                    output: '',
                    error: `NO_ACTION: action at index ${actionIndex} is null or undefined.`,
                };
            }

            const originalText = doc.getText();

            // Preview the changes before applying
            let diff: string | undefined;
            if (action.edit) {
                // Check if this document has edits in the workspace edit
                if (action.edit.has(vscode.Uri.file(absPath))) {
                    const textEdits = action.edit.get(vscode.Uri.file(absPath));
                    const newText = applyTextEdits(originalText, textEdits);
                    diff = createTwoFilesPatch(
                        relPath,
                        relPath + ' (after action)',
                        originalText,
                        newText,
                        'before',
                        'after',
                    );
                }
            }

            // Apply the code action
            if (previewOnly) {
                return {
                    success: true,
                    output: JSON.stringify({
                        file: relPath,
                        actionIndex,
                        actionTitle: action.title,
                        actionKind: action.kind?.value ?? '',
                        previewOnly: true,
                        applied: false,
                        diff: diff ?? '',
                    }, null, 2),
                };
            }

            // Actually apply the action
            if (action.edit) {
                await vscode.workspace.applyEdit(action.edit);
            }
            if (action.command) {
                await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments || []));
            }

            return {
                success: true,
                output: JSON.stringify({
                    file: relPath,
                    actionIndex,
                    actionTitle: action.title,
                    actionKind: action.kind?.value ?? '',
                    previewOnly: false,
                    applied: true,
                    diff: diff ?? '',
                }, null, 2),
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

/** Apply an array of TextEdits to a string in reverse order (to preserve offsets). */
function applyTextEdits(text: string, edits: vscode.TextEdit[]): string {
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
    if (text[offset] === '\r') offset += 1;
    return offset + pos.character;
}
