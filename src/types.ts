// TypeScript interfaces for the chat system
export interface Attachment {
    id: string;
    name: string;
    content: string;
    type: 'file' | 'code' | 'image';
    size: number;
}

export interface ChatConfig {
    modelEndpoint: string;
    modelName: string;
    apiKey: string;
    contextWindowSize: number;
    defaultMode: string;
    openCodeEnabled: boolean;
    openCodeApiKey?: string;
    temperature: number;
    topP: number;
    topK: number;
    presencePenalty: number;
    repetitionPenalty: number;
    minP: number;
    /** Model name for embedding API calls (default: text-embedding-3-small) */
    embeddingModel?: string;
}

export interface NativeToolCall {
    id: string;
    type: string;
    function: { name: string; arguments: string };
}

export interface ChatCompletionMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: NativeToolCall[];
    tool_call_id?: string;
    _partial?: boolean;
}

export interface ParsedToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    raw?: string;
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    status: 'pending' | 'executing' | 'completed' | 'failed';
    result?: unknown;
}

// Codebase index types
export type SymbolKind =
    | 'class'
    | 'interface'
    | 'type'
    | 'function'
    | 'method'
    | 'property'
    | 'enum'
    | 'const'
    | 'template';

export interface SymbolEntry {
    name: string;
    kind: SymbolKind;
    line: number;
    /** End line of the symbol (1-indexed, inclusive). Populated by LSP extraction. */
    endLine?: number;
    /** Name of the containing symbol (e.g., class name for a method). */
    containerName?: string;
    /** Signature or type detail from the language server (e.g., "(x: number): void"). */
    detail?: string;
}

export interface IndexedFile {
    path: string;          // relative to workspace root
    size: number;
    language: string;
    symbols: SymbolEntry[];
}

export interface CodebaseIndex {
    version: number;
    root: string;
    files: Record<string, IndexedFile>;
}

export interface IndexStats {
    fileCount: number;
    symbolCount: number;
    languages: Record<string, number>;
}

// Retrieval types
export interface RetrievedChunk {
    filePath: string;       // relative to workspace root
    startLine: number;
    endLine: number;
    text: string;
    tokenCount: number;
    symbols: SymbolEntry[]; // symbols in this chunk
    score: number;          // 0-1 relevance score
    source: 'symbol' | 'recency' | 'keyword';
}

export interface RetrievalResult {
    chunks: RetrievedChunk[];
    totalTokens: number;
    queryTokens: number;
}

// Summarization types
export interface SummaryBlock {
    /** The compressed summary text injected as a system note. */
    summary: string;
    /** Number of original messages that were compressed into this block. */
    compressedCount: number;
    /** Token count of the summary itself. */
    tokenCount: number;
}