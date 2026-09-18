import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, toWorkspaceRelative } from '../pathSafety';

const SEVERITY_MAP: Record<number, string> = {
    0: 'error',
    1: 'warning',
    2: 'info',
    3: 'hint',
};

export class GetDiagnosticsExecutor implements ToolExecutor {
    public name = 'get_diagnostics';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const pathFilter = args.path ? String(args.path) : undefined;
            const severityFilter = args.severity ? String(args.severity).toLowerCase() : undefined;
            const maxResults = args.maxResults !== undefined ? Number(args.maxResults) : 50;

            const workspaceRoot = getWorkspaceRoot();
            const results: Array<{
                file: string;
                severity: string;
                code: string | number | undefined;
                source: string | undefined;
                message: string;
                line: number;
                endLine: number;
            }> = [];

            // Get diagnostics for target URIs
            let urisToCheck: vscode.Uri[] = [];

            if (pathFilter) {
                const target = resolveWorkspacePath(pathFilter, workspaceRoot);
                urisToCheck.push(vscode.Uri.file(target));
            } else {
                // Workspace-wide: check all open documents and known files
                urisToCheck = vscode.workspace.textDocuments.map(d => d.uri);
            }

            for (const uri of urisToCheck) {
                if (results.length >= maxResults) break;

                const diagList = vscode.languages.getDiagnostics(uri);
                for (const diag of diagList) {
                    if (results.length >= maxResults) break;

                    const severity = SEVERITY_MAP[diag.severity] ?? 'unknown';

                    // Apply severity filter
                    if (severityFilter && severity !== severityFilter) continue;

                    const range = diag.range;
                    results.push({
                        file: toWorkspaceRelative(uri.fsPath, workspaceRoot),
                        severity,
                        code: diag.code instanceof vscode.Uri ? diag.code.toString() : String(diag.code ?? ''),
                        source: diag.source,
                        message: diag.message,
                        line: range.start.line + 1, // 1-indexed
                        endLine: range.end.line + 1,
                    });
                }
            }

            // Summary counts
            const counts = { error: 0, warning: 0, info: 0, hint: 0 };
            for (const r of results) {
                if (r.severity in counts) counts[r.severity as keyof typeof counts]++;
            }

            const output = {
                total: results.length,
                counts,
                diagnostics: results,
            };

            return { success: true, output: JSON.stringify(output, null, 2) };
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('PATH_TRAVERSAL') || err.message.includes('SYMLINK_ESCAPE')) {
                return { success: false, output: '', error: err.message };
            }
            return { success: false, output: '', error: err.message };
        }
    }
}
