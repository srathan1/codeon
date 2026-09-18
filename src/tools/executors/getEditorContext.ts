import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot, toWorkspaceRelative } from '../pathSafety';

export class GetEditorContextExecutor implements ToolExecutor {
    public name = 'get_editor_context';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const includeSelections = args.includeSelections !== false;
            const includeOpenEditors = args.includeOpenEditors === true;
            const includeVisibleRanges = args.includeVisibleRanges === true;

            const workspaceRoot = getWorkspaceRoot();
            const result: Record<string, unknown> = {};

            // Active editor
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const activeInfo: Record<string, unknown> = {
                    path: toWorkspaceRelative(activeEditor.document.uri.fsPath, workspaceRoot),
                    languageId: activeEditor.document.languageId,
                    lineCount: activeEditor.document.lineCount,
                    isDirty: activeEditor.document.isDirty,
                };

                if (includeSelections && activeEditor.selection) {
                    const sel = activeEditor.selection;
                    const selectedText = activeEditor.document.getText(sel);
                    activeInfo.selection = {
                        startLine: sel.start.line,
                        startCharacter: sel.start.character,
                        endLine: sel.end.line,
                        endCharacter: sel.end.character,
                        selectedText: selectedText.slice(0, 500), // Bound selection text
                    };
                }

                if (includeVisibleRanges) {
                    const visibleRanges = activeEditor.visibleRanges;
                    if (visibleRanges.length > 0) {
                        const vr = visibleRanges[0];
                        activeInfo.visibleRange = {
                            startLine: vr.start.line,
                            endLine: vr.end.line,
                        };
                    }
                }

                result.activeEditor = activeInfo;
            } else {
                result.activeEditor = null;
            }

            // Open editors
            if (includeOpenEditors) {
                result.openEditors = vscode.window.visibleTextEditors.map(ed => ({
                    path: toWorkspaceRelative(ed.document.uri.fsPath, workspaceRoot),
                    languageId: ed.document.languageId,
                    isDirty: ed.document.isDirty,
                }));
            }

            return { success: true, output: JSON.stringify(result, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
