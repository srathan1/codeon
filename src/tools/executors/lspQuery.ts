import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, toWorkspaceRelative } from '../pathSafety';

/** Map LSP SymbolKind enum values to human-readable names. */
const SYMBOL_KIND_MAP: Record<number, string> = {
    1: 'File',
    2: 'Module',
    3: 'Namespace',
    4: 'Package',
    5: 'Class',
    6: 'Method',
    7: 'Property',
    8: 'Field',
    9: 'Constructor',
    10: 'Enum',
    11: 'Interface',
    12: 'Function',
    13: 'Variable',
    14: 'Constant',
    15: 'String',
    16: 'Number',
    17: 'Boolean',
    18: 'Array',
    19: 'Object',
    20: 'Key',
    21: 'Null',
    22: 'EnumMember',
    23: 'Struct',
    24: 'Event',
    25: 'Operator',
    26: 'TypeParameter',
};

/** Parse a position JSON string into a vscode.Position. */
function parsePosition(raw: string): vscode.Position {
    const parsed = JSON.parse(raw) as { line: number; character: number };
    return new vscode.Position(parsed.line, parsed.character);
}

/** Resolve a workspace-relative path to an open TextDocument (opens it if needed). */
async function openDocument(workspaceRoot: string, relPath: string): Promise<vscode.TextDocument> {
    const absPath = resolveWorkspacePath(relPath, workspaceRoot);
    return vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
}

/** Serialize a MarkdownString or MarkedString to plain text. */
function serializeContent(content: vscode.MarkdownString | string | { language: string; value: string }): string {
    if (content instanceof vscode.MarkdownString) {
        return content.value;
    }
    if (typeof content === 'string') {
        return content;
    }
    // MarkedString object form: { language: string; value: string }
    if ('value' in content && typeof content.value === 'string') {
        return content.value;
    }
    return String(content);
}

export class LspQueryExecutor implements ToolExecutor {
    public name = 'lsp_query';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const operation = String(args.operation || '');
            const relPath = args.path ? String(args.path) : undefined;
            const positionRaw = args.position ? String(args.position) : undefined;
            const query = args.query ? String(args.query) : undefined;
            const maxResults = args.maxResults !== undefined ? Number(args.maxResults) : 50;

            const workspaceRoot = getWorkspaceRoot();

            switch (operation) {
                case 'document_symbols': {
                    if (!relPath) return { success: false, output: '', error: 'MISSING_PARAM: path is required for document_symbols' };
                    const doc = await openDocument(workspaceRoot, relPath);
                    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.provideDocumentSymbols', doc.uri);
                    const result = symbols
                        ?.slice(0, maxResults)
                        .map(s => ({
                            name: s.name,
                            kind: SYMBOL_KIND_MAP[s.kind] ?? `Unknown(${s.kind})`,
                            range: { startLine: s.range.start.line + 1, endLine: s.range.end.line + 1 },
                            children: s.children?.map(c => ({
                                name: c.name,
                                kind: SYMBOL_KIND_MAP[c.kind] ?? `Unknown(${c.kind})`,
                                range: { startLine: c.range.start.line + 1, endLine: c.range.end.line + 1 },
                            })),
                        })) || [];
                    return { success: true, output: JSON.stringify({ file: relPath, count: result.length, symbols: result }, null, 2) };
                }

                case 'workspace_symbols': {
                    if (!query) return { success: false, output: '', error: 'MISSING_PARAM: query is required for workspace_symbols' };
                    // Use the VS Code command API for workspace symbol search
                    const results = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.workspace.symbol.search', query);
                    const symbolList = (results || []).slice(0, maxResults).map(s => ({
                        name: s.name,
                        kind: SYMBOL_KIND_MAP[s.kind] ?? `Unknown(${s.kind})`,
                        containerName: s.containerName,
                        file: toWorkspaceRelative(s.location.uri.fsPath, workspaceRoot),
                        line: s.location.range.start.line + 1,
                    }));
                    return { success: true, output: JSON.stringify({ query, count: symbolList.length, symbols: symbolList }, null, 2) };
                }

                case 'definition':
                case 'declaration':
                case 'type_definition':
                case 'implementation': {
                    if (!relPath) return { success: false, output: '', error: 'MISSING_PARAM: path is required for ' + operation };
                    if (!positionRaw) return { success: false, output: '', error: 'MISSING_PARAM: position is required for ' + operation };
                    const doc = await openDocument(workspaceRoot, relPath);
                    const pos = parsePosition(positionRaw);
                    let locations: vscode.Location[] | vscode.LocationLink[] | undefined;

                    if (operation === 'definition') {
                        locations = await vscode.commands.executeCommand<vscode.Location[]>(
                            'vscode.provideDefinition', doc.uri, pos,
                        );
                    } else if (operation === 'declaration') {
                        locations = await vscode.commands.executeCommand<vscode.Location[]>(
                            'vscode.provideDeclaration', doc.uri, pos,
                        );
                    } else if (operation === 'type_definition') {
                        locations = await vscode.commands.executeCommand<vscode.Location[]>(
                            'vscode.provideTypeDefinition', doc.uri, pos,
                        );
                    } else {
                        // implementation
                        locations = await vscode.commands.executeCommand<vscode.Location[]>(
                            'vscode.provideImplementation', doc.uri, pos,
                        );
                    }

                    const locArray = (locations || []).slice(0, maxResults);
                    const defs = locArray.map((loc: vscode.Location | vscode.LocationLink) => {
                        const uri: vscode.Uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
                        let range: vscode.Range;
                        if ('targetSelectionRange' in loc) {
                            range = loc.targetSelectionRange ?? new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
                        } else {
                            range = (loc as vscode.Location).range;
                        }
                        return {
                            file: toWorkspaceRelative(uri.fsPath, workspaceRoot),
                            line: range.start.line + 1,
                            column: range.start.character + 1,
                        };
                    });
                    return { success: true, output: JSON.stringify({ operation, file: relPath, count: defs.length, locations: defs }, null, 2) };
                }

                case 'references': {
                    if (!relPath) return { success: false, output: '', error: 'MISSING_PARAM: path is required for references' };
                    if (!positionRaw) return { success: false, output: '', error: 'MISSING_PARAM: position is required for references' };
                    const doc = await openDocument(workspaceRoot, relPath);
                    const pos = parsePosition(positionRaw);
                    const refs = await vscode.commands.executeCommand<vscode.Location[]>(
                        'vscode.provideReferences', doc.uri, pos,
                    );
                    const refList = (refs || []).slice(0, maxResults).map(r => ({
                        file: toWorkspaceRelative(r.uri.fsPath, workspaceRoot),
                        line: r.range.start.line + 1,
                        column: r.range.start.character + 1,
                    }));
                    return { success: true, output: JSON.stringify({ file: relPath, count: refList.length, references: refList }, null, 2) };
                }

                case 'hover': {
                    if (!relPath) return { success: false, output: '', error: 'MISSING_PARAM: path is required for hover' };
                    if (!positionRaw) return { success: false, output: '', error: 'MISSING_PARAM: position is required for hover' };
                    const doc = await openDocument(workspaceRoot, relPath);
                    const pos = parsePosition(positionRaw);
                    const hover = await vscode.commands.executeCommand<vscode.Hover>(
                        'vscode.provideHover', doc.uri, pos,
                    );
                    if (!hover) {
                        return { success: true, output: JSON.stringify({ file: relPath, hover: null }, null, 2) };
                    }
                    const contents = hover.contents.map(c => serializeContent(c));
                    return { success: true, output: JSON.stringify({ file: relPath, hover: { contents, range: hover.range ? { startLine: hover.range.start.line + 1, endLine: hover.range.end.line + 1 } : null } }, null, 2) };
                }

                case 'signature_help': {
                    if (!relPath) return { success: false, output: '', error: 'MISSING_PARAM: path is required for signature_help' };
                    if (!positionRaw) return { success: false, output: '', error: 'MISSING_PARAM: position is required for signature_help' };
                    const doc = await openDocument(workspaceRoot, relPath);
                    const pos = parsePosition(positionRaw);
                    const sigHelp = await vscode.commands.executeCommand<vscode.SignatureHelp>(
                        'vscode.provideSignatureHelp', doc.uri, pos,
                    );
                    if (!sigHelp) {
                        return { success: true, output: JSON.stringify({ file: relPath, signatures: [] }, null, 2) };
                    }
                    const signatures = sigHelp.signatures.slice(0, maxResults).map((sig, idx) => ({
                        index: idx,
                        label: sig.label,
                        documentation: sig.documentation instanceof vscode.MarkdownString ? sig.documentation.value : String(sig.documentation ?? ''),
                        parameters: sig.parameters.map(p => ({
                            label: typeof p.label === 'string' ? p.label : `${p.label[0]}-${p.label[1]}`,
                            documentation: p.documentation instanceof vscode.MarkdownString ? p.documentation.value : String(p.documentation ?? ''),
                        })),
                    }));
                    return { success: true, output: JSON.stringify({ file: relPath, activeSignature: sigHelp.activeSignature, activeParameter: sigHelp.activeParameter, signatures }, null, 2) };
                }

                case 'incoming_calls':
                case 'outgoing_calls': {
                    if (!relPath) return { success: false, output: '', error: 'MISSING_PARAM: path is required for ' + operation };
                    if (!positionRaw) return { success: false, output: '', error: 'MISSING_PARAM: position is required for ' + operation };
                    const doc = await openDocument(workspaceRoot, relPath);
                    const pos = parsePosition(positionRaw);
                    const callHierarchy = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
                        'vscode.prepareCallHierarchy', doc.uri, pos,
                    );
                    if (!callHierarchy || callHierarchy.length === 0) {
                        return { success: true, output: JSON.stringify({ file: relPath, calls: [] }, null, 2) };
                    }
                    const item = callHierarchy[0];
                    // In VS Code 1.82, we use command-based approach for incoming/outgoing calls
                    let callItems: Array<{ name: string; file: string; ranges: Array<{ startLine: number }> }> = [];
                    if (operation === 'incoming_calls') {
                        const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
                            'vscode.provideCallHierarchyIncomingCalls', item,
                        );
                        callItems = (incoming || []).slice(0, maxResults).map(c => ({
                            name: c.from.name,
                            file: toWorkspaceRelative(c.from.uri.fsPath, workspaceRoot),
                            ranges: c.fromRanges.map(r => ({ startLine: r.start.line + 1 })),
                        }));
                    } else {
                        const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
                            'vscode.provideCallHierarchyOutgoingCalls', item,
                        );
                        callItems = (outgoing || []).slice(0, maxResults).map(c => ({
                            name: c.to.name,
                            file: toWorkspaceRelative(c.to.uri.fsPath, workspaceRoot),
                            ranges: c.fromRanges.map(r => ({ startLine: r.start.line + 1 })),
                        }));
                    }
                    return { success: true, output: JSON.stringify({ operation, file: relPath, count: callItems.length, calls: callItems }, null, 2) };
                }

                case 'rename_preview': {
                    if (!relPath) return { success: false, output: '', error: 'MISSING_PARAM: path is required for rename_preview' };
                    if (!positionRaw) return { success: false, output: '', error: 'MISSING_PARAM: position is required for rename_preview' };
                    if (!query) return { success: false, output: '', error: 'MISSING_PARAM: query (new name) is required for rename_preview' };
                    const doc = await openDocument(workspaceRoot, relPath);
                    const pos = parsePosition(positionRaw);
                    const workspaceEdit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
                        'vscode.provideRenameEdits', doc.uri, pos, query,
                    );
                    if (!workspaceEdit || workspaceEdit.size === 0) {
                        return { success: true, output: JSON.stringify({ file: relPath, newName: query, changes: [] }, null, 2) };
                    }
                    // Iterate over all open documents to find which ones have edits
                    const changes: Array<{ file: string; edits: Array<{ range: { startLine: number; endLine: number }; text: string }> }> = [];
                    for (const td of vscode.workspace.textDocuments) {
                        if (workspaceEdit.has(td.uri)) {
                            const textEdits = workspaceEdit.get(td.uri);
                            if (textEdits.length > 0) {
                                const filePath = toWorkspaceRelative(td.uri.fsPath, workspaceRoot);
                                const edits = textEdits.map(te => ({
                                    range: { startLine: te.range.start.line + 1, endLine: te.range.end.line + 1 },
                                    text: te.newText,
                                }));
                                changes.push({ file: filePath, edits });
                            }
                        }
                    }
                    return { success: true, output: JSON.stringify({ file: relPath, newName: query, filesChanged: changes.length, changes }, null, 2) };
                }

                default:
                    return {
                        success: false,
                        output: '',
                        error: `UNKNOWN_OPERATION: '${operation}'. Supported: document_symbols, workspace_symbols, definition, declaration, references, type_definition, implementation, hover, signature_help, incoming_calls, outgoing_calls, rename_preview`,
                    };
            }
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('PATH_TRAVERSAL') || err.message.includes('SYMLINK_ESCAPE')) {
                return { success: false, output: '', error: err.message };
            }
            return { success: false, output: '', error: err.message };
        }
    }
}
