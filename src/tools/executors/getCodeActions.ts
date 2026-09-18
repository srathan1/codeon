import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, toWorkspaceRelative } from '../pathSafety';

export class GetCodeActionsExecutor implements ToolExecutor {
    public name = 'get_code_actions';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const relPath = String(args.path || '');
            const startLine = args.startLine !== undefined ? Number(args.startLine) : undefined;
            const endLine = args.endLine !== undefined ? Number(args.endLine) : undefined;
            const kindFilter = args.kind ? String(args.kind).toLowerCase() : undefined;

            const workspaceRoot = getWorkspaceRoot();
            const absPath = resolveWorkspacePath(relPath, workspaceRoot);

            // Open the document
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));

            // Determine range for code actions
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
                // Whole document
                range = new vscode.Range(
                    new vscode.Position(0, 0),
                    new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length),
                );
            }

            // Fetch code actions. The built-in `vscode.executeCodeActionProvider`
            // command's third argument is a plain kind-filter STRING (or
            // undefined) — VS Code builds diagnostics/triggerKind internally
            // from the given range itself. Passing a full CodeActionContext
            // object here (as this previously did) fails VS Code's own
            // argument-shape validation with "Invalid argument 'kind'", since
            // it expects `kind` to be a string, not an object — this crashed
            // every call, filtered or not, before it could return anything.
            const rawActions = await vscode.commands.executeCommand<(vscode.Command | vscode.CodeAction)[]>(
                'vscode.executeCodeActionProvider',
                doc.uri,
                range,
                kindFilter,
            );

            if (!rawActions || rawActions.length === 0) {
                return {
                    success: true,
                    output: JSON.stringify({
                        file: relPath,
                        count: 0,
                        actions: [],
                        message: 'No code actions available for the specified range.',
                    }, null, 2),
                };
            }

            // Filter by kind if requested. rawActions can mix legacy Command
            // entries (no `kind`) with CodeAction entries — 'kind' in a narrows
            // to CodeAction for TS, and is also the runtime guard against
            // plain Command entries lacking that property.
            let actions = rawActions;
            if (kindFilter) {
                actions = rawActions.filter(a => {
                    if (!a || !('kind' in a) || !a.kind) return false;
                    return a.kind.value.toLowerCase().includes(kindFilter);
                });
            }

            // Serialize actions (without executing them)
            const actionList = actions.map((action, index) => ({
                index,
                title: action?.title ?? '',
                kind: (action && 'kind' in action && action.kind) ? action.kind.value : '',
                isPreferred: (action && 'isPreferred' in action) ? !!action.isPreferred : false,
                hasEdit: !!(action && 'edit' in action && action.edit),
                hasCommands: !!(action && 'command' in action && action.command),
            }));

            return {
                success: true,
                output: JSON.stringify({
                    file: relPath,
                    range: {
                        startLine: range.start.line + 1,
                        endLine: range.end.line + 1,
                    },
                    count: actionList.length,
                    actions: actionList,
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
