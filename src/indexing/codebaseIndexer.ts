import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import ignore, { Ignore } from 'ignore';
import { CodebaseIndex, IndexedFile, IndexStats, SymbolEntry, SymbolKind } from '../types';

// Language extensions mapped to human-readable names
const LANGUAGE_MAP: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c_header',
    '.hpp': 'cpp_header',
    '.cs': 'csharp',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.html': 'html',
    '.htm': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less',
};

// Default patterns to always ignore (even without .gitignore)
const DEFAULT_IGNORE_PATTERNS = [
    'node_modules/',
    '.git/',
    '__pycache__/',
    '*.pyc',
    '*.o',
    '*.so',
    '*.dll',
    '*.dylib',
    'dist/',
    'build/',
    'out/',
    '.next/',
    '.nuxt/',
    '*.min.js',
    '*.min.css',
    '*.map',
    '.DS_Store',
    'Thumbs.db',
];

// Symbol extraction regexes per language family
// Each pattern captures: (1) kind hint, (2) symbol name
const SYMBOL_PATTERNS: Record<string, Array<{ regex: RegExp; kind: string }>> = {
    typescript: [
        { regex: /^export\s+default\s+function\s+(\w+)/m, kind: 'function' },
        { regex: /^\s*export\s+function\s+(\w+)/m, kind: 'function' },
        { regex: /^\s*function\s+(\w+)/m, kind: 'function' },
        { regex: /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/m, kind: 'method' },
        { regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m, kind: 'class' },
        { regex: /^\s*(?:export\s+)?interface\s+(\w+)/m, kind: 'interface' },
        { regex: /^\s*(?:export\s+)?type\s+(\w+)/m, kind: 'type' },
        { regex: /^\s*(?:export\s+)?enum\s+(\w+)/m, kind: 'enum' },
        { regex: /^\s*(?:export\s+)?const\s+(\w+)/m, kind: 'const' },
    ],
    javascript: [
        { regex: /^export\s+default\s+function\s+(\w+)/m, kind: 'function' },
        { regex: /^\s*export\s+function\s+(\w+)/m, kind: 'function' },
        { regex: /^\s*function\s+(\w+)/m, kind: 'function' },
        { regex: /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/m, kind: 'function' },
        { regex: /^\s*(?:const|let|var)\s+(\w+)\s*=\s*\{/m, kind: 'const' },
        { regex: /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*[{=]/m, kind: 'method' },
        { regex: /^\s*class\s+(\w+)/m, kind: 'class' },
    ],
    python: [
        { regex: /^\s*def\s+(\w+)/m, kind: 'function' },
        { regex: /^\s*class\s+(\w+)/m, kind: 'class' },
    ],
    java: [
        { regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?class\s+(\w+)/m, kind: 'class' },
        { regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?interface\s+(\w+)/m, kind: 'interface' },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+(\w+)\s*\([^)]*\)/m, kind: 'method' },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?final\s+(\w+)/m, kind: 'const' },
    ],
    cpp: [
        { regex: /^\s*(?:class|struct)\s+(\w+)/m, kind: 'class' },
        { regex: /^\s*(?:void|int|float|double|bool|char|auto|long|short|unsigned|signed|[\w:]+)\s+(\w+)\s*\([^)]*\)\s*(?:const\s*)?\{/m, kind: 'method' },
    ],
    c: [
        { regex: /^\s*(?:struct|union|enum)\s+(\w+)/m, kind: 'class' },
        { regex: /^\s*(?:void|int|float|double|char|long|short|unsigned|signed)\s+(\w+)\s*\([^)]*\)\s*\{/m, kind: 'function' },
    ],
    csharp: [
        { regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?class\s+(\w+)/m, kind: 'class' },
        { regex: /^\s*(?:public|private|protected)?\s*(?:static\s+)?interface\s+(\w+)/m, kind: 'interface' },
        { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+(\w+)\s*\([^)]*\)/m, kind: 'method' },
    ],
    go: [
        { regex: /^\s*func\s+\(.*?\)\s+(\w+)/m, kind: 'method' },
        { regex: /^\s*func\s+(\w+)/m, kind: 'function' },
        { regex: /^\s*type\s+(\w+)\s+struct/m, kind: 'class' },
    ],
    rust: [
        { regex: /^\s*(?:pub\s+)?fn\s+(\w+)/m, kind: 'function' },
        { regex: /^\s*(?:pub\s+)?(?:trait|struct|enum)\s+(\w+)/m, kind: 'class' },
        { regex: /^\s*(?:pub\s+)?impl.*?\{?/m, kind: 'class' }, // rough impl block detection
    ],
    html: [
        { regex: /id=["'](\w+)["']/m, kind: 'template' },       // id="myElement"
        { regex: /class=["']([\w-]+)(?:\s+[\w-]+)*["']/m, kind: 'const' }, // class names
    ],
    css: [
        { regex: /^\.([\w-]+)/m, kind: 'const' },           // .className
        { regex: /^#([\w-]+)/m, kind: 'function' },          // #idName
        { regex: /@(?:keyframes|mixin|include)\s+([\w-]+)/m, kind: 'function' }, // @keyframes/mixin
    ],
};

/** Get the language family for a file extension. */
function getLanguageFamily(ext: string): string | null {
    const lang = LANGUAGE_MAP[ext.toLowerCase()];
    if (!lang) return null;
    // Map to pattern family
    if (lang === 'typescript' || lang === 'javascript') return lang;
    if (lang === 'python') return 'python';
    if (lang === 'java' || lang === 'kotlin') return 'java';
    if (lang === 'cpp' || lang === 'cpp_header') return 'cpp';
    if (lang === 'c' || lang === 'c_header') return 'c';
    if (lang === 'csharp') return 'csharp';
    if (lang === 'go') return 'go';
    if (lang === 'rust') return 'rust';
    if (lang === 'html') return 'html';
    if (lang === 'css' || lang === 'scss' || lang === 'less') return 'css';
    return null;
}

/** Extract symbols from source code by language family (regex fallback). */
function extractSymbols(content: string, languageFamily: string): SymbolEntry[] {
    const patterns = SYMBOL_PATTERNS[languageFamily];
    if (!patterns) return [];

    const lines = content.split('\n');
    const symbols: SymbolEntry[] = [];
    const seen = new Set<string>();

    // P6-T4: track the line number with the loop index. The previous
    // `lines.indexOf(line)` returned the FIRST line whose text equalled the
    // current line, so any symbol on a line whose exact text repeats elsewhere
    // (e.g. `};`, an overloaded signature) got the wrong number — and it was
    // O(n²). The index is both correct and O(n).
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { regex, kind } of patterns) {
            const match = line.match(regex);
            if (match && match[1]) {
                const name = match[1];
                // Skip single-letter names and common keywords that aren't real symbols
                if (name.length < 2 || ['if', 'for', 'while', 'switch', 'catch', 'new', 'return'].includes(name)) {
                    continue;
                }
                const key = `${kind}:${name}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    symbols.push({ name, kind: kind as SymbolEntry['kind'], line: i + 1 });
                }
                break; // One match per line
            }
        }
    }

    return symbols;
}

/** Map LSP SymbolKind enum values to our SymbolKind type. */
const LSP_KIND_MAP: Record<number, SymbolKind> = {
    [vscode.SymbolKind.File]: 'const',
    [vscode.SymbolKind.Module]: 'type',
    [vscode.SymbolKind.Namespace]: 'type',
    [vscode.SymbolKind.Package]: 'type',
    [vscode.SymbolKind.Class]: 'class',
    [vscode.SymbolKind.Method]: 'method',
    [vscode.SymbolKind.Property]: 'property',
    [vscode.SymbolKind.Field]: 'property',
    [vscode.SymbolKind.Constructor]: 'method',
    [vscode.SymbolKind.Enum]: 'enum',
    [vscode.SymbolKind.Interface]: 'interface',
    [vscode.SymbolKind.Function]: 'function',
    [vscode.SymbolKind.Variable]: 'const',
    [vscode.SymbolKind.Constant]: 'const',
    [vscode.SymbolKind.String]: 'const',
    [vscode.SymbolKind.Number]: 'const',
    [vscode.SymbolKind.Boolean]: 'const',
    [vscode.SymbolKind.Array]: 'const',
    [vscode.SymbolKind.Object]: 'type',
    [vscode.SymbolKind.Key]: 'property',
    [vscode.SymbolKind.Null]: 'const',
    [vscode.SymbolKind.EnumMember]: 'const',
    [vscode.SymbolKind.Struct]: 'class',
    [vscode.SymbolKind.Event]: 'method',
    [vscode.SymbolKind.Operator]: 'method',
    [vscode.SymbolKind.TypeParameter]: 'type',
};

/**
 * Flatten a tree of vscode.DocumentSymbol into SymbolEntry[].
 * Child symbols get containerName set to their parent's name.
 */
function flattenDocumentSymbols(
    symbols: readonly vscode.DocumentSymbol[],
    containerName: string | undefined
): SymbolEntry[] {
    const result: SymbolEntry[] = [];

    for (const s of symbols) {
        const kind = LSP_KIND_MAP[s.kind] || 'function';
        const selectionStart = s.selectionRange.start.line + 1; // 1-indexed
        const selectionEnd = s.selectionRange.end.line + 1;

        result.push({
            name: s.name,
            kind,
            line: selectionStart,
            endLine: selectionEnd,
            containerName: containerName || undefined,
            detail: s.detail || undefined,
        });

        if (s.children && s.children.length > 0) {
            result.push(...flattenDocumentSymbols(s.children, s.name));
        }
    }

    return result;
}

/**
 * Extract symbols using VS Code's built-in LSP.
 * Returns an empty array if the language server is not available or returns no symbols.
 */
export async function extractSymbolsFromLSP(uri: vscode.Uri): Promise<SymbolEntry[]> {
    try {
        // Open the document in the editor model (does NOT show it in the UI)
        const doc = await vscode.workspace.openTextDocument(uri);

        // Query the language server for document symbols
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.provideDocumentSymbols',
            uri
        );

        if (!symbols || symbols.length === 0) {
            return [];
        }

        return flattenDocumentSymbols(symbols, undefined);
    } catch {
        // LSP not available for this language — caller falls back to regex
        return [];
    }
}

export class CodebaseIndexer {
    private index: CodebaseIndex = { version: 2, root: '', files: {} };
    private ig: Ignore = ignore();
    private watcher: vscode.Disposable | null = null;
    private _onDidChangeIndex = new vscode.EventEmitter<void>();
    public readonly onDidChangeIndex = this._onDidChangeIndex.event;

    constructor(
        private readonly workspaceRoot: string,
        private readonly storagePath: string
    ) {
        this.index.root = workspaceRoot;
        this.loadIgnorePatterns();
    }

    /** Load .gitignore patterns from workspace root. */
    private loadIgnorePatterns(): void {
        this.ig = ignore();

        // Add default patterns
        for (const pattern of DEFAULT_IGNORE_PATTERNS) {
            this.ig.add(pattern);
        }

        // Read .gitignore if it exists
        const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            try {
                const content = fs.readFileSync(gitignorePath, 'utf8');
                this.ig.add(content);
            } catch {
                // Ignore read errors
            }
        }
    }

    /** Check if a relative path should be ignored. */
    isIgnored(relativePath: string): boolean {
        // Normalize path separators for ignore library
        const normalized = relativePath.replace(/\\/g, '/');
        return this.ig.ignores(normalized);
    }

    /** Walk the workspace and build the full index asynchronously.
     * Processes files in batches to avoid blocking the main thread on large repos. */
    async rebuildIndex(): Promise<void> {
        console.log(`[CodebaseIndexer] Rebuilding index for ${this.workspaceRoot}`);

        this.index.files = {};
        let fileCount = 0;
        let symbolCount = 0;

        // Collect all eligible file paths first (async directory walk)
        const filePaths: string[] = [];

        const collectPaths = async (dir: string): Promise<void> => {
            try {
                const entries = await fsp.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    const relPath = path.relative(this.workspaceRoot, fullPath);

                    if (entry.isDirectory()) {
                        if (!this.isIgnored(relPath + '/')) {
                            await collectPaths(fullPath);
                        }
                    } else if (entry.isFile()) {
                        if (!this.isIgnored(relPath)) {
                            const ext = path.extname(entry.name).toLowerCase();
                            if (getLanguageFamily(ext)) {
                                filePaths.push(fullPath);
                            }
                        }
                    }
                }
            } catch {
                // Skip unreadable directories
            }
        };

        await collectPaths(this.workspaceRoot);

        // Process files in batches to keep the UI responsive.
        // Use smaller batch size for LSP calls (slower than regex).
        const BATCH_SIZE = 50;
        for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
            const batch = filePaths.slice(i, i + BATCH_SIZE);

            for (const fullPath of batch) {
                const relPath = path.relative(this.workspaceRoot, fullPath);
                const ext = path.extname(fullPath).toLowerCase();
                const languageFamily = getLanguageFamily(ext)!;

                try {
                    const stats = await fsp.stat(fullPath);
                    const uri = vscode.Uri.file(fullPath);

                    // Try LSP first — falls back to regex if LSP unavailable
                    let symbols = await extractSymbolsFromLSP(uri);

                    // Fallback: if LSP returned nothing, use regex extraction
                    if (symbols.length === 0) {
                        const content = await fsp.readFile(fullPath, 'utf8');
                        symbols = extractSymbols(content, languageFamily);
                    }

                    const indexedFile: IndexedFile = {
                        path: relPath,
                        size: stats.size,
                        language: LANGUAGE_MAP[ext] || 'unknown',
                        symbols,
                    };

                    this.index.files[relPath] = indexedFile;
                    fileCount++;
                    symbolCount += symbols.length;
                } catch {
                    // Skip unreadable files (binary, permission issues)
                }
            }

            // Yield to event loop between batches so VS Code stays responsive
            if (i + BATCH_SIZE < filePaths.length) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }

        this.saveIndex();

        console.log(
            `[CodebaseIndexer] Indexed ${fileCount} files, ${symbolCount} symbols`
        );

        this._onDidChangeIndex.fire();
    }

    /** Save index to disk. */
    private saveIndex(): void {
        try {
            const indexPath = path.join(this.storagePath, 'index.json');
            fs.mkdirSync(path.dirname(indexPath), { recursive: true });
            fs.writeFileSync(indexPath, JSON.stringify(this.index, null, 2));
        } catch (err) {
            console.error('[CodebaseIndexer] Failed to save index:', err);
        }
    }

    /** Load index from disk (used on startup for incremental mode). */
    loadIndex(): boolean {
        try {
            const indexPath = path.join(this.storagePath, 'index.json');
            if (!fs.existsSync(indexPath)) return false;

            const raw = fs.readFileSync(indexPath, 'utf8');
            const loaded = JSON.parse(raw) as CodebaseIndex;

            // Only use cached index if it's for the same workspace
            if (loaded.root === this.workspaceRoot && loaded.version === 1) {
                this.index = loaded;
                console.log(
                    `[CodebaseIndexer] Loaded cached index: ${Object.keys(loaded.files).length} files`
                );
                return true;
            }
        } catch (err) {
            console.error('[CodebaseIndexer] Failed to load index:', err);
        }
        return false;
    }

    /** Start watching filesystem for incremental updates. */
    startWatching(): vscode.Disposable {
        // Reload ignore patterns in case .gitignore changed
        this.loadIgnorePatterns();

        const createWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, '**/*'),
            false, // ignoreCreate
            false, // ignoreChange
            false  // ignoreDelete
        );

        // Debounce handler to avoid re-indexing on every rapid file change
        let timer: NodeJS.Timeout | null = null;
        const debounceReindex = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                this.updateIndexIncremental();
            }, 2000);
        };

        createWatcher.onDidChange(debounceReindex);
        createWatcher.onDidCreate(debounceReindex);
        createWatcher.onDidDelete(debounceReindex);

        this.watcher = createWatcher;

        return new vscode.Disposable(() => {
            createWatcher.dispose();
            if (timer) clearTimeout(timer);
        });
    }

    /** Update a single file in the index (called by file watcher).
     * Uses async I/O to avoid blocking the main thread. */
    private async updateIndexIncremental(): Promise<void> {
        const existingPaths = new Set(Object.keys(this.index.files));
        const currentPaths = new Set<string>();

        const walk = async (dir: string): Promise<void> => {
            try {
                const entries = await fsp.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    const relPath = path.relative(this.workspaceRoot, fullPath);

                    if (entry.isDirectory()) {
                        if (!this.isIgnored(relPath + '/')) {
                            await walk(fullPath);
                        }
                    } else if (entry.isFile() && !this.isIgnored(relPath)) {
                        const fileExt = path.extname(entry.name).toLowerCase();
                        const languageFamily = getLanguageFamily(fileExt);

                        if (languageFamily) {
                            currentPaths.add(relPath);
                            try {
                                const stats = await fsp.stat(fullPath);
                                const uri = vscode.Uri.file(fullPath);

                                // Try LSP first, fall back to regex
                                let symbols = await extractSymbolsFromLSP(uri);
                                if (symbols.length === 0) {
                                    const content = await fsp.readFile(fullPath, 'utf8');
                                    symbols = extractSymbols(content, languageFamily);
                                }

                                this.index.files[relPath] = {
                                    path: relPath,
                                    size: stats.size,
                                    language: LANGUAGE_MAP[fileExt] || 'unknown',
                                    symbols,
                                };
                            } catch {
                                // Skip unreadable files
                            }
                        }
                    }
                }
            } catch {
                // Skip unreadable directories
            }
        };

        await walk(this.workspaceRoot);

        // Remove deleted files
        for (const p of existingPaths) {
            if (!currentPaths.has(p)) {
                delete this.index.files[p];
            }
        }

        this.saveIndex();
        this._onDidChangeIndex.fire();
    }

    /** Dispose watchers and cleanup. */
    dispose(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }
        this._onDidChangeIndex.dispose();
    }

    // --- Query API ---

    /** Search for symbols by name (case-insensitive substring match). */
    querySymbol(name: string): Array<{ file: string; symbol: SymbolEntry }> {
        const query = name.toLowerCase();
        const results: Array<{ file: string; symbol: SymbolEntry }> = [];

        for (const [filePath, file] of Object.entries(this.index.files)) {
            for (const sym of file.symbols) {
                if (sym.name.toLowerCase().includes(query)) {
                    results.push({ file: filePath, symbol: sym });
                }
            }
        }

        // Sort by best match (exact name first, then startsWith, then substring)
        results.sort((a, b) => {
            const aScore = symbolMatchScore(a.symbol.name, name);
            const bScore = symbolMatchScore(b.symbol.name, name);
            return bScore - aScore;
        });

        return results;
    }

    /** Get all indexed files filtered by language. */
    queryByLanguage(language: string): IndexedFile[] {
        return Object.values(this.index.files).filter(
            f => f.language === language
        );
    }

    /** Get all indexed files. */
    getAllFiles(): IndexedFile[] {
        return Object.values(this.index.files);
    }

    /** Get index statistics. */
    getIndexStats(): IndexStats {
        const files = Object.values(this.index.files);
        const languages: Record<string, number> = {};

        for (const file of files) {
            languages[file.language] = (languages[file.language] || 0) + 1;
        }

        return {
            fileCount: files.length,
            symbolCount: files.reduce((sum, f) => sum + f.symbols.length, 0),
            languages,
        };
    }

    /** Get the raw index (for serialization to webview or other consumers). */
    getIndex(): CodebaseIndex {
        return this.index;
    }
}

/** Score a symbol name match: higher = better match. */
function symbolMatchScore(symbolName: string, query: string): number {
    const s = symbolName.toLowerCase();
    const q = query.toLowerCase();
    if (s === q) return 3;
    if (s.startsWith(q)) return 2;
    if (s.includes(q)) return 1;
    return 0;
}
