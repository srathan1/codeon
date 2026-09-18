import * as fs from 'fs';
import * as path from 'path';
import { ApiClient } from '../api/apiClient';

/** A single indexed entry: file path + embedding vector + metadata. */
export interface SemanticEntry {
    filePath: string;
    embedding: number[];
    /** Summary text used to generate the embedding (symbol names + file context) */
    summary: string;
}

/** Persisted format for disk storage. */
interface SemanticIndexData {
    version: number;
    entries: SemanticEntry[];
}

const CURRENT_VERSION = 1;

/**
 * Cosine similarity between two vectors. Returns value in [-1, 1].
 */
function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;

    return dot / denom;
}

/**
 * Build a summary string for a file from its symbols and path.
 * This is what gets embedded — not the full file content.
 */
export function buildFileSummary(filePath: string, symbolNames: string[]): string {
    // Combine path context + symbol names into a meaningful summary
    const parts = [filePath];
    if (symbolNames.length > 0) {
        parts.push('Contains: ' + symbolNames.join(', '));
    }
    return parts.join(' | ');
}

/**
 * In-memory semantic index for codebase files.
 * Stores embedding vectors per-file and supports similarity search.
 */
export class SemanticIndex {
    private entries: SemanticEntry[] = [];
    private _enabled = false;

    constructor(
        private readonly storagePath: string,
        private readonly apiClient: ApiClient
    ) {}

    /** Return true if embeddings are available (provider supports them). */
    get enabled(): boolean { return this._enabled; }

    /** Load persisted index from disk. */
    load(): boolean {
        try {
            const indexPath = path.join(this.storagePath, 'semantic-index.json');
            if (!fs.existsSync(indexPath)) return false;

            const raw = fs.readFileSync(indexPath, 'utf8');
            const data = JSON.parse(raw) as SemanticIndexData;

            if (data.version !== CURRENT_VERSION) return false;

            this.entries = data.entries;
            return true;
        } catch {
            return false;
        }
    }

    /** Save index to disk. */
    save(): void {
        try {
            const indexPath = path.join(this.storagePath, 'semantic-index.json');
            fs.mkdirSync(path.dirname(indexPath), { recursive: true });
            fs.writeFileSync(indexPath, JSON.stringify({ version: CURRENT_VERSION, entries: this.entries }, null, 2));
        } catch (err) {
            console.error('[SemanticIndex] Failed to save:', err);
        }
    }

    /**
     * Index a batch of files by generating embeddings for their summaries.
     * Returns true if embeddings were generated, false if provider doesn't support them.
     */
    async addFiles(files: Array<{ filePath: string; symbols: string[] }>): Promise<boolean> {
        if (files.length === 0) return false;

        // Generate embeddings in parallel (batch of up to 20)
        const BATCH_SIZE = 20;
        const summaries = files.map(f => buildFileSummary(f.filePath, f.symbols));

        for (let i = 0; i < summaries.length; i += BATCH_SIZE) {
            const batch = summaries.slice(i, i + BATCH_SIZE);

            // Generate embeddings for the batch
            const embeddings = await Promise.all(batch.map(s => this.apiClient.generateEmbedding(s)));

            // If first batch returned all nulls, provider doesn't support embeddings
            if (i === 0 && embeddings.every(e => e === null)) {
                return false;
            }

            // Store successful embeddings
            for (let j = 0; j < batch.length; j++) {
                const idx = i + j;
                const embedding = embeddings[j];
                if (embedding) {
                    // Remove existing entry for this file if any
                    this.entries = this.entries.filter(e => e.filePath !== files[idx].filePath);
                    this.entries.push({
                        filePath: files[idx].filePath,
                        embedding,
                        summary: batch[j],
                    });
                }
            }

            // Yield between batches
            if (i + BATCH_SIZE < summaries.length) {
                await new Promise(r => setImmediate(r));
            }
        }

        this._enabled = true;
        return true;
    }

    /**
     * Search for files similar to the query text.
     * Returns top-K results sorted by cosine similarity.
     */
    search(query: string, topK: number = 5): Array<{ filePath: string; score: number }> {
        if (!this._enabled || this.entries.length === 0) return [];

        // Generate embedding for the query
        const queryEmbeddingPromise = this.apiClient.generateEmbedding(query);

        // We need to return synchronously — but embedding generation is async.
        // This method is only called from the async retrieve() which awaits it.
        return [] as any; // Placeholder — actual search is done in searchAsync below
    }

    /**
     * Async version of search that generates the query embedding first.
     */
    async searchAsync(query: string, topK: number = 5): Promise<Array<{ filePath: string; score: number }>> {
        if (!this._enabled || this.entries.length === 0) return [];

        const queryEmbedding = await this.apiClient.generateEmbedding(query);
        if (!queryEmbedding) return [];

        // Score all entries against the query
        const scored: Array<{ filePath: string; score: number }> = [];

        for (const entry of this.entries) {
            const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
            // Only include entries with positive similarity (better than random)
            if (similarity > 0.3) {
                scored.push({ filePath: entry.filePath, score: similarity });
            }
        }

        // Sort by similarity descending, take top-K
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }

    /** Remove entries for deleted files. */
    removeFiles(filePaths: Set<string>): void {
        this.entries = this.entries.filter(e => !filePaths.has(e.filePath));
    }

    /** Clear all entries. */
    clear(): void {
        this.entries = [];
        this._enabled = false;
    }

    /** Get the number of indexed files. */
    size(): number {
        return this.entries.length;
    }
}
