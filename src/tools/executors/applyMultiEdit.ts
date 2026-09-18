import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, isProtectedPath } from '../pathSafety';
import { hashContent, countLineDiff, checkFileStale } from '../fileVersion';

/** A single edit within a multi-edit transaction. */
interface FileEdit {
    path: string;
    mode: 'create' | 'edit' | 'delete';
    newContent?: string;      // for create
    oldText?: string;         // for edit (precise replacement)
    newText?: string;         // for edit
    expectedVersion?: string; // optional stale guard
}

/** Per-file result after applying an edit. */
interface EditResult {
    path: string;
    success: boolean;
    action: string;
    added: number;
    removed: number;
    diff?: string;
    error?: string;
    beforeHash?: string;
    afterHash?: string;
}

export class ApplyMultiEditExecutor implements ToolExecutor {
    public name = 'apply_multi_edit';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            let rawEdits = args.edits;

            // Handle the case where the LLM sends edits as a JSON string instead of a native array.
            if (typeof rawEdits === 'string') {
                try {
                    rawEdits = JSON.parse(rawEdits);
                } catch {
                    return { success: false, output: '', error: 'INVALID_ARGS: "edits" string could not be parsed as JSON' };
                }
            }

            if (!Array.isArray(rawEdits)) {
                return { success: false, output: '', error: 'INVALID_ARGS: "edits" must be an array of FileEdit objects' };
            }

            const edits = rawEdits.map((e: Record<string, unknown>) => ({
                path: String(e.path || ''),
                mode: e.mode as 'create' | 'edit' | 'delete' || 'create',
                newContent: typeof e.newContent === 'string' ? e.newContent : undefined,
                oldText: typeof e.oldText === 'string' ? e.oldText : undefined,
                newText: typeof e.newText === 'string' ? e.newText : undefined,
                expectedVersion: typeof e.expectedVersion === 'string' ? e.expectedVersion : undefined,
            })).filter((e: FileEdit) => e.path);

            if (edits.length === 0) {
                return { success: false, output: '', error: 'INVALID_ARGS: no valid edits provided' };
            }

            // Cap batch size to prevent runaway operations
            if (edits.length > 20) {
                return { success: false, output: '', error: `BATCH_TOO_LARGE: max 20 edits per transaction (got ${edits.length})` };
            }

            const workspaceRoot = getWorkspaceRoot();
            const results: EditResult[] = [];
            const workspaceEdit = new vscode.WorkspaceEdit();

            // --- Phase 1: Validate all edits (fail fast, no partial apply) ---
            for (const edit of edits) {
                const absPath = resolveWorkspacePath(edit.path, workspaceRoot);

                // Protected path check
                if (isProtectedPath(absPath)) {
                    return { success: false, output: '', error: `PROTECTED_PATH: ${edit.path}` };
                }

                if (edit.mode === 'edit') {
                    if (!fs.existsSync(absPath)) {
                        return { success: false, output: '', error: `FILE_NOT_FOUND: cannot edit ${edit.path} — file does not exist (use mode: "create")` };
                    }
                    if (!edit.oldText) {
                        return { success: false, output: '', error: `MISSING_ARG: edit mode requires "oldText" for ${edit.path}` };
                    }
                    if (edit.expectedVersion) {
                        const stale = checkFileStale(absPath, edit.expectedVersion);
                        if (stale.stale) {
                            return { success: false, output: '', error: stale.reason ?? 'STALE_FILE_VERSION' };
                        }
                    }
                } else if (edit.mode === 'delete') {
                    if (!fs.existsSync(absPath)) {
                        return { success: false, output: '', error: `FILE_NOT_FOUND: cannot delete ${edit.path} — does not exist` };
                    }
                } else if (edit.mode === 'create') {
                    if (!edit.newContent && edit.path) {
                        // Allow empty content for file creation
                    }
                }

                // Ensure parent directory exists for creates
                if (edit.mode === 'create') {
                    fs.mkdirSync(path.dirname(absPath), { recursive: true });
                }
            }

            // --- Phase 2: Build WorkspaceEdit for all file changes ---
            for (const edit of edits) {
                const absPath = resolveWorkspacePath(edit.path, workspaceRoot);
                const uri = vscode.Uri.file(absPath);
                const exists = fs.existsSync(absPath);
                const oldContent = exists ? fs.readFileSync(absPath, 'utf8') : '';
                const beforeHash = oldContent ? hashContent(oldContent) : '(new file)';

                let newContent: string;
                let action: string;

                if (edit.mode === 'create') {
                    newContent = edit.newContent ?? '';
                    action = 'created';
                } else if (edit.mode === 'delete') {
                    // For delete, we schedule a delete operation
                    workspaceEdit.deleteFile(uri);
                    results.push({
                        path: edit.path,
                        success: true,
                        action: 'deleted',
                        added: 0,
                        removed: oldContent.split('\n').length,
                        beforeHash,
                        afterHash: '(deleted)',
                    });
                    continue;
                } else if (edit.mode === 'edit') {
                    // Find and replace oldText → newText
                    const oldText = edit.oldText!;
                    const newText = edit.newText ?? '';
                    const indices: number[] = [];
                    let searchFrom = 0;
                    while (true) {
                        const idx = oldContent.indexOf(oldText, searchFrom);
                        if (idx === -1) break;
                        indices.push(idx);
                        searchFrom = idx + 1;
                    }

                    if (indices.length === 0) {
                        return {
                            success: false,
                            output: '',
                            error: `NO_MATCH: '${oldText.slice(0, 50)}...' not found in ${edit.path} — aborting entire transaction`,
                        };
                    }

                    newContent = oldContent.split(oldText).join(newText);
                    action = `edited (${indices.length} replacement${indices.length > 1 ? 's' : ''})`;
                } else {
                    newContent = '';
                    action = 'unknown';
                }

                const afterHash = hashContent(newContent);
                const { added, removed } = countLineDiff(oldContent, newContent);

                const unifiedDiff = createTwoFilesPatch(
                    edit.path,
                    edit.path,
                    oldContent,
                    newContent,
                    '(original)',
                    '(modified)'
                );

                // Add to WorkspaceEdit for atomic apply + undo support
                const document = await vscode.workspace.openTextDocument(uri);
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                );
                workspaceEdit.replace(uri, fullRange, newContent);

                results.push({
                    path: edit.path,
                    success: true,
                    action,
                    added,
                    removed,
                    diff: unifiedDiff,
                    beforeHash,
                    afterHash,
                });
            }

            // --- Phase 3: Apply atomically ---
            const applied = await vscode.workspace.applyEdit(workspaceEdit);
            if (!applied) {
                // Try to identify which edit failed by checking concurrent modification
                for (const edit of edits) {
                    if (edit.mode === 'edit' || edit.mode === 'create') {
                        const absPath = resolveWorkspacePath(edit.path, workspaceRoot);
                        try {
                            const doc = await vscode.workspace.openTextDocument(absPath);
                            // Check if current doc content differs from what we read
                            const currentContent = doc.getText();
                            const currentHash = hashContent(currentContent);
                            const origResult = results.find(r => r.path === edit.path);
                            if (origResult && origResult.beforeHash !== '(new file)' && currentHash !== origResult.beforeHash) {
                                return {
                                    success: false,
                                    output: '',
                                    error: `CONCURRENT_MODIFICATION: ${edit.path} was modified by another process — rolling back entire transaction. No files were changed. Re-read with read_file then retry.`,
                                };
                            }
                        } catch { /* skip */ }
                    }
                }
                return {
                    success: false,
                    output: '',
                    error: 'APPLY_FAILED: WorkspaceEdit could not be applied — possible concurrent modification. Transaction rolled back. Re-read the affected files with read_file, then retry.',
                };
            }

            // --- Phase 4: Save all documents ---
            const docsToSave = new Set<vscode.TextDocument>();
            for (const edit of edits) {
                if (edit.mode === 'delete') continue;
                const absPath = resolveWorkspacePath(edit.path, workspaceRoot);
                try {
                    const doc = await vscode.workspace.openTextDocument(absPath);
                    docsToSave.add(doc);
                } catch { /* skip */ }
            }

            // P5-T15: the in-memory WorkspaceEdit applied atomically, but saves
            // are per-document and can partially fail (permissions, disk full).
            // We can't cleanly roll back a filesystem save across N files, so
            // instead of a blanket "SAVE_FAILED" we report exactly which files
            // reached disk and which didn't, so the model/user can reconcile the
            // partial state rather than guess at it.
            const docList = [...docsToSave];
            const saveOutcomes = await Promise.all(docList.map(async (doc) => {
                try {
                    const ok = await doc.save();
                    return { path: doc.uri.fsPath, saved: ok };
                } catch (e) {
                    return { path: doc.uri.fsPath, saved: false, error: (e as Error).message };
                }
            }));

            const failed = saveOutcomes.filter(o => !o.saved);
            if (failed.length > 0) {
                const savedPaths = saveOutcomes.filter(o => o.saved).map(o => path.relative(workspaceRoot, o.path));
                const failedPaths = failed.map(o => path.relative(workspaceRoot, o.path));
                return {
                    success: false,
                    output: '',
                    error: [
                        `PARTIAL_SAVE_FAILURE: ${failed.length} of ${saveOutcomes.length} file(s) could not be saved.`,
                        savedPaths.length ? `Saved to disk (NOT rolled back — the workspace is now in a partial state): ${savedPaths.join(', ')}.` : 'No files were saved to disk.',
                        `Failed to save: ${failedPaths.join(', ')}.`,
                        'Re-read the affected files with read_file to see the current state before retrying.',
                    ].join('\n'),
                };
            }

            // Build output
            let output = `Applied ${results.length} edit(s):\n\n`;
            for (const r of results) {
                output += `- ${r.path}: ${r.action} (+${r.added} -${r.removed})\n`;
            }

            return { success: true, output };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
