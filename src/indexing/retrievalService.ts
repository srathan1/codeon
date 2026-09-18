import * as fs from 'fs';
import * as path from 'path';
import { getEncoding } from 'js-tiktoken';
import { CodebaseIndexer } from './codebaseIndexer';
import { SemanticIndex, buildFileSummary } from './semanticIndex';
import { IndexedFile, RetrievedChunk, RetrievalResult, SymbolEntry } from '../types';
import { ApiClient } from '../api/apiClient';

// Common words to strip when extracting keywords from a query
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
    'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this', 'these',
    'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
    'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'what',
    'which', 'who', 'whom', 'please', 'fix', 'debug', 'refactor', 'explain',
    'implement', 'add', 'remove', 'update', 'change', 'find', 'search',
    'look', 'check', 'show', 'tell', 'help', 'use', 'get', 'set', 'make',
]);

/**
 * Extract candidate symbol names from a natural language query.
 * Strips stop words, keeps alphanumeric identifiers (3+ chars to avoid noise).
 */
function extractKeywords(query: string): string[] {
    // Pull out word sequences that look like identifiers
    const words = query.replace(/[^a-zA-Z0-9_\s]/g, ' ').split(/\s+/);
    return words
        .map(w => w.trim())
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()));
}

/**
 * Score how well a file matches the extracted keywords.
 * Higher score = more relevant.
 */
function scoreFile(file: IndexedFile, keywords: string[]): number {
    if (keywords.length === 0) return 0;

    let score = 0;
    const fileLower = file.path.toLowerCase();

    for (const kw of keywords) {
        const kwLower = kw.toLowerCase();

        // Check filename match (strong signal)
        const basename = path.basename(file.path).toLowerCase();
        if (basename.includes(kwLower)) {
            score += 5;
        }

        // Check path match
        if (fileLower.includes(kwLower)) {
            score += 2;
        }

        // Check symbol name matches (strongest signal)
        for (const sym of file.symbols) {
            const symLower = sym.name.toLowerCase();
            if (symLower === kwLower) {
                score += 10;
            } else if (symLower.startsWith(kwLower)) {
                score += 7;
            } else if (symLower.includes(kwLower)) {
                score += 4;
            }
        }
    }

    return score;
}

/**
 * Token-count a piece of text using cl100k_base.
 */
const encoder = getEncoding('cl100k_base');
function countTokens(text: string): number {
    if (!text) return 0;
    return encoder.encode(text).length;
}

/**
 * Extract a meaningful code chunk around matched symbols.
 * Returns lines covering all matched symbols with some padding.
 */
function extractChunkAroundSymbols(
    content: string,
    symbols: SymbolEntry[],
    padLines: number = 8
): { startLine: number; endLine: number; text: string } | null {
    if (symbols.length === 0) return null;

    const lines = content.split('\n');
    const symbolLines = symbols.map(s => s.line).sort((a, b) => a - b);

    let start = Math.max(1, symbolLines[0] - padLines);
    let end = Math.min(lines.length, symbolLines[symbolLines.length - 1] + padLines);

    // Don't auto-expand to full file — keep chunks focused on matched symbols
    const chunkText = lines.slice(start - 1, end).join('\n');
    return { startLine: start, endLine: end, text: chunkText };
}

export interface RetrievalOptions {
    /** Maximum number of files to retrieve (default: 5) */
    topK?: number;
    /** Maximum tokens for retrieved context (default: 2048) */
    maxTokens?: number;
    /** Padding lines around matched symbols (default: 8) */
    padLines?: number;
    /** Recency boost factor — recently touched files get this multiplier (default: 1.5) */
    recencyBoost?: number;
    /** Minimum score threshold to include a file (default: 1) */
    minScore?: number;
}

const DEFAULT_OPTIONS: Required<RetrievalOptions> = {
    topK: 3,
    maxTokens: 4096,
    padLines: 8,
    recencyBoost: 1.5,
    minScore: 2,
};

export class RetrievalService {
    private options: Required<RetrievalOptions>;
    private recentFiles: Map<string, number> = new Map(); // path -> timestamp
    private recentFileTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private semanticIndex: SemanticIndex | null = null;

    constructor(
        private readonly indexer: CodebaseIndexer,
        private readonly workspaceRoot: string,
        options?: RetrievalOptions
    ) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /** Initialize the semantic index with an API client. Called once on startup. */
    async initSemanticIndex(apiClient: ApiClient, storagePath: string): Promise<void> {
        this.semanticIndex = new SemanticIndex(storagePath, apiClient);

        // Try loading persisted index first
        if (this.semanticIndex.load()) {
            console.log(`[RetrievalService] Loaded semantic index: ${this.semanticIndex.size()} entries`);
            return;
        }

        // Build from scratch using current codebase index
        const files = this.indexer.getAllFiles();
        const fileSummaries = files.map(f => ({
            filePath: f.path.replace(/\\/g, '/'),
            symbols: f.symbols.map(s => s.name),
        }));

        const success = await this.semanticIndex!.addFiles(fileSummaries);
        if (success) {
            this.semanticIndex!.save();
            console.log(`[RetrievalService] Built semantic index: ${this.semanticIndex!.size()} entries`);
        } else {
            console.log('[RetrievalService] Embeddings not supported by current provider — semantic search disabled');
            this.semanticIndex = null;
        }
    }

    /**
     * Record that a file was recently opened or edited.
     * Files stay "recent" for 5 minutes by default.
     */
    touchFile(relativePath: string): void {
        const key = relativePath.replace(/\\/g, '/');
        this.recentFiles.set(key, Date.now());

        // Clear existing expiry
        const existing = this.recentFileTimeouts.get(key);
        if (existing) clearTimeout(existing);

        // Expire after 5 minutes
        const timer = setTimeout(() => {
            this.recentFiles.delete(key);
            this.recentFileTimeouts.delete(key);
        }, 5 * 60 * 1000);
        this.recentFileTimeouts.set(key, timer);
    }

    /**
     * Retrieve relevant code chunks for a user query.
     * Blends keyword/symbol matching with semantic similarity when available.
     */
    async retrieve(query: string): Promise<RetrievalResult> {
        const keywords = extractKeywords(query);
        const queryTokens = countTokens(query);

        // Phase 1: Symbol-based lookup (exact/starts-with/includes)
        const symbolMatches = new Map<string, { score: number; symbols: string[] }>();
        for (const kw of keywords) {
            const results = this.indexer.querySymbol(kw);
            for (const hit of results) {
                const key = hit.file.replace(/\\/g, '/');
                const existing = symbolMatches.get(key);
                if (!existing || hit.symbol.name.toLowerCase() === kw.toLowerCase()) {
                    symbolMatches.set(key, {
                        score: hit.symbol.name.toLowerCase() === kw.toLowerCase() ? 15 : 8,
                        symbols: [kw],
                    });
                }
            }
        }

        // Phase 2: Score all indexed files by keyword relevance
        const scored: Array<{ file: IndexedFile; score: number; source: RetrievedChunk['source'] }> = [];
        const seen = new Set<string>();

        // Add symbol matches first
        for (const [filePath, data] of symbolMatches) {
            const indexed = this.indexer.getIndex().files[filePath];
            if (indexed && !seen.has(filePath)) {
                seen.add(filePath);
                scored.push({ file: indexed, score: data.score, source: 'symbol' });
            }
        }

        // Score remaining files
        for (const file of this.indexer.getAllFiles()) {
            const key = file.path.replace(/\\/g, '/');
            if (seen.has(key)) continue;

            const rawScore = scoreFile(file, keywords);
            if (rawScore >= this.options.minScore) {
                seen.add(key);
                scored.push({ file, score: rawScore, source: 'keyword' });
            }
        }

        // Phase 3: Apply recency boost
        for (const entry of scored) {
            const key = entry.file.path.replace(/\\/g, '/');
            if (this.recentFiles.has(key)) {
                entry.score *= this.options.recencyBoost;
                // Mark as recency-influenced if it wasn't already a symbol match
                if (entry.source !== 'symbol') {
                    entry.source = 'recency';
                }
            }
        }

        // Phase 3.5: Semantic similarity (when available)
        const semanticScores = new Map<string, number>();
        if (this.semanticIndex && this.semanticIndex.enabled) {
            try {
                const semanticResults = await this.semanticIndex.searchAsync(query, this.options.topK * 2);
                for (const hit of semanticResults) {
                    semanticScores.set(hit.filePath.replace(/\\/g, '/'), hit.score);
                }
            } catch {
                // Semantic search failed — continue with keyword-only
            }
        }

        // Boost scores for files that matched semantically
        for (const entry of scored) {
            const key = entry.file.path.replace(/\\/g, '/');
            const semanticScore = semanticScores.get(key);
            if (semanticScore !== undefined && semanticScore > 0.4) {
                // Add semantic score as a bonus (0-1 range, scaled to match keyword scores)
                entry.score += semanticScore * 10;
            }
        }

        // Also add high-scoring semantic matches that weren't found by keywords
        for (const [filePath, semScore] of semanticScores) {
            const indexed = this.indexer.getIndex().files[filePath];
            if (indexed && !seen.has(filePath) && semScore > 0.5) {
                seen.add(filePath);
                scored.push({ file: indexed, score: semScore * 10, source: 'keyword' });
            }
        }

        // Sort by score descending, take top-K
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, this.options.topK);

        // Phase 4: Extract chunks, respecting token budget
        const chunks: RetrievedChunk[] = [];
        let totalTokens = 0;

        for (const { file, score, source } of top) {
            const fullPath = path.join(this.workspaceRoot, file.path);
            try {
                const content = fs.readFileSync(fullPath, 'utf8');

                // Determine which symbols are relevant (matched by keywords)
                const relevantSymbols = file.symbols.filter(sym => {
                    return keywords.some(kw =>
                        sym.name.toLowerCase().includes(kw.toLowerCase())
                    );
                });

                // If no specific symbols matched, skip this file — don't load it blindly
                if (relevantSymbols.length === 0) continue;

                const chunk = extractChunkAroundSymbols(
                    content,
                    relevantSymbols,
                    this.options.padLines
                );

                if (!chunk) continue;

                const tokenCount = countTokens(chunk.text);

                // Skip if this single chunk exceeds our budget
                if (tokenCount > this.options.maxTokens) continue;

                // Stop adding if we'd exceed the budget
                if (totalTokens + tokenCount > this.options.maxTokens) break;

                // Normalize score to 0-1 range (max possible ~20 per keyword * keywords)
                const maxPossible = keywords.length * 20 * Math.max(1, this.options.recencyBoost);
                const normalizedScore = Math.min(1, score / maxPossible);

                chunks.push({
                    filePath: file.path,
                    startLine: chunk.startLine,
                    endLine: chunk.endLine,
                    text: chunk.text,
                    tokenCount,
                    symbols: relevantSymbols,
                    score: normalizedScore,
                    source,
                });

                totalTokens += tokenCount;
            } catch {
                // Skip unreadable files
            }
        }

        return {
            chunks,
            totalTokens,
            queryTokens,
        };
    }

    /**
     * Build a system-prompt snippet from retrieved chunks.
     */
    formatContext(result: RetrievalResult): string {
        if (result.chunks.length === 0) return '';

        const parts = result.chunks.map(c => {
            const lang = c.symbols.length > 0 ? c.filePath.split('.').pop() : '';
            return `--- ${c.filePath} (lines ${c.startLine}-${c.endLine}) ---\n\`\`\`${lang}\n${c.text}\n\`\`\``;
        });

        return `Here are relevant files from the codebase:\n\n${parts.join('\n\n')}`;
    }

    /** Dispose cleanup. */
    dispose(): void {
        for (const timer of this.recentFileTimeouts.values()) {
            clearTimeout(timer);
        }
        this.recentFileTimeouts.clear();
        this.recentFiles.clear();
    }
}
