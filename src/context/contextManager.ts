import { Attachment, ChatConfig, ChatCompletionMessage, RetrievedChunk, SummaryBlock, NativeToolCall } from '../types';
import { getEncoding } from 'js-tiktoken';

// Shared encoder instance (cl100k_base is used by GPT-4, GPT-3.5, and most OpenAI-compatible models)
const encoder = getEncoding('cl100k_base');

/** Minimum number of recent messages to keep verbatim (sliding window). */
const MIN_KEEP_TAIL = 8;

/** Default threshold: trigger summarization when context exceeds this % of window. */
const DEFAULT_SUMMARIZE_THRESHOLD = 0.75;

/** Hard threshold: aggressive trim when context exceeds this %. */
const HARD_TRIM_THRESHOLD = 0.85;

export class ContextManager {
    private attachments: Attachment[] = [];
    private apiMessages: ChatCompletionMessage[] = [];
    private retrievedChunks: RetrievedChunk[] = [];
    private config: ChatConfig;
    /** Tracks summary blocks injected into the conversation. */
    private summaries: SummaryBlock[] = [];
    /** Configurable summarize threshold (0 = disabled). */
    private _summarizeThreshold: number = DEFAULT_SUMMARIZE_THRESHOLD;

    constructor(config: ChatConfig) {
        this.config = config;
    }

    /** Set the auto-summarize threshold as a percentage (0-100). 0 disables auto-summarize. */
    setSummarizeThreshold(percent: number): void {
        this._summarizeThreshold = Math.max(0, Math.min(1, percent / 100));
    }

    /** Get the current summarize threshold as a percentage. */
    getSummarizeThreshold(): number {
        return Math.round(this._summarizeThreshold * 100);
    }

    /** Set the API message array for token counting. */
    setApiMessages(messages: ChatCompletionMessage[]): void {
        this.apiMessages = messages;
    }

    // Add an attachment to the context
    addAttachment(attachment: Attachment): void {
        this.attachments.push(attachment);
    }

    // Clear context
    clearContext(): void {
        this.attachments = [];
        this.apiMessages = [];
        this.retrievedChunks = [];
        this.summaries = [];
    }

    /** Get the current API messages array. */
    getApiMessages(): ChatCompletionMessage[] {
        return [...this.apiMessages];
    }

    /** Count tokens in a string using the model's encoder. */
    static countTokens(text: string): number {
        if (!text) return 0;
        return encoder.encode(text).length;
    }

    /**
     * Estimate the token cost of a single tool_call entry.
     * Counts id, type, function name, and arguments.
     */
    private static countToolCallTokens(tc: NativeToolCall): number {
        let total = 0;
        if (tc.id) total += ContextManager.countTokens(tc.id);
        if (tc.type) total += ContextManager.countTokens(tc.type);
        if (tc.function?.name) total += ContextManager.countTokens(tc.function.name);
        if (tc.function?.arguments) total += ContextManager.countTokens(tc.function.arguments);
        return total;
    }

    /**
     * Estimate the token cost of a single message exactly as getContextSize()
     * counts it (role prefix + content + tool_call_id + tool_calls overhead).
     *
     * P-2: exposed as a standalone helper so callers that remove messages one
     * at a time (context trimming / emergency drop) can maintain a running
     * total via subtraction instead of calling getContextSize() — a full
     * re-tokenize of every remaining message via real tiktoken encoding —
     * on every single removal. A trim that drops k of n messages previously
     * cost O(n × k) tiktoken-encode work; with a running total it's O(n)
     * total regardless of k.
     */
    static countMessageTokens(msg: ChatCompletionMessage): number {
        // Role prefix costs ~1 token
        let total = 1;
        if (msg.content) {
            total += ContextManager.countTokens(msg.content);
        }
        if (msg.tool_call_id) {
            total += ContextManager.countTokens(msg.tool_call_id);
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                total += ContextManager.countToolCallTokens(tc);
            }
        }
        return total;
    }

    /**
     * Get approximate token count of the full conversation context.
     * Counts tokens in apiMessages (system/user/assistant/tool) plus attachments.
     * Includes tool_calls overhead (arguments, names, ids) which can be substantial.
     */
    getContextSize(): number {
        let total = 0;

        for (const msg of this.apiMessages) {
            total += ContextManager.countMessageTokens(msg);
        }

        // Count attachment content
        for (const att of this.attachments) {
            total += ContextManager.countTokens(att.content);
        }

        return total;
    }

    /**
     * Check if the conversation should be summarized.
     * Returns true when context exceeds the configured threshold and there are enough messages to compress.
     */
    shouldSummarize(): boolean {
        // Disabled by config
        if (this._summarizeThreshold <= 0) return false;

        const usage = this.getContextSize();
        const threshold = this.config.contextWindowSize * this._summarizeThreshold;
        if (usage < threshold) return false;

        // Need enough non-system messages to make compression worthwhile
        const compressible = this.apiMessages.filter(m => m.role !== 'system').length;
        return compressible > MIN_KEEP_TAIL + 2; // At least 2 messages to compress
    }

    /**
     * Check if we're in danger zone and need aggressive trimming.
     */
    needsHardTrim(): boolean {
        const usage = this.getContextSize();
        return usage >= this.config.contextWindowSize * HARD_TRIM_THRESHOLD;
    }

    // ------------------------------------------------------------------------
    // Tool-call pair awareness
    // ------------------------------------------------------------------------

    /**
     * Check whether a message is part of a tool-call exchange:
     * - assistant with tool_calls, or
     - tool with a tool_call_id that matches an assistant's tool_call.
     */
    private _isToolMessage(msg: ChatCompletionMessage): boolean {
        return msg.role === 'tool';
    }

    /**
     * Check whether an assistant message has tool_calls.
     */
    private _hasToolCalls(msg: ChatCompletionMessage): boolean {
        return msg.role === 'assistant' && !!msg.tool_calls && msg.tool_calls.length > 0;
    }

    /**
     * Given a contiguous range of non-system messages, trim it so that
     * we never orphan a tool-call pair. If the last message in the range
     * is an assistant with tool_calls but has no matching tool results in
     * the range, shrink the range to exclude that assistant message (and
     * anything after it within the range).
     */
    private _ensureToolCallPairsComplete(toCompress: ChatCompletionMessage[]): ChatCompletionMessage[] {
        if (toCompress.length === 0) return toCompress;

        // Walk backwards. If the tail of toCompress ends with an assistant
        // that has tool_calls but no subsequent tool messages, chop it off.
        let end = toCompress.length;
        for (let i = toCompress.length - 1; i >= 0; i--) {
            if (this._hasToolCalls(toCompress[i])) {
                // Check if any tool messages follow this assistant in the range
                const hasMatchingTool = toCompress.slice(i + 1, end).some(m => m.role === 'tool');
                if (!hasMatchingTool) {
                    // Orphaned tool_calls — shrink the range to exclude this assistant
                    end = i;
                }
            }
        }

        return toCompress.slice(0, end);
    }

    /**
     * Find the indices in apiMessages that correspond to the given messages,
     * respecting tool-call pair integrity. If a message at index i is removed,
     * and it's an assistant with tool_calls whose tool results also appear in
     * the removal set, include them too (they already are). If the tool results
     * are NOT in the removal set, exclude the assistant to avoid orphans.
     * Conversely, if a tool result is selected but its parent assistant isn't,
     * include the assistant too.
     */
    private _resolveIndicesWithPairs(toRemove: ChatCompletionMessage[]): number[] {
        // Build a Set of object references for O(1) lookup
        const removeSet = new Set(toRemove);
        const indices: number[] = [];

        for (let i = 0; i < this.apiMessages.length; i++) {
            if (removeSet.has(this.apiMessages[i])) {
                indices.push(i);
            }
        }

        // Now check for orphans: for each assistant with tool_calls in the
        // removal set, ensure its tool results are also included.
        const indicesSet = new Set(indices);
        const additions: number[] = [];

        for (const idx of indices) {
            const msg = this.apiMessages[idx];
            if (this._hasToolCalls(msg)) {
                // Find tool results that reference this assistant's tool calls
                const callIds = new Set(msg.tool_calls!.map(tc => tc.id));
                for (let j = idx + 1; j < this.apiMessages.length; j++) {
                    const later = this.apiMessages[j];
                    if (later.role !== 'tool') continue;
                    if (later.tool_call_id && callIds.has(later.tool_call_id)) {
                        if (!indicesSet.has(j)) {
                            additions.push(j);
                        }
                    }
                }
            } else if (msg.role === 'tool' && msg.tool_call_id) {
                // Tool result without parent assistant in removal set —
                // find and include the parent assistant
                for (let j = idx - 1; j >= 0; j--) {
                    const earlier = this.apiMessages[j];
                    if (earlier.role !== 'assistant') continue;
                    if (earlier.tool_calls?.some(tc => tc.id === msg.tool_call_id)) {
                        if (!indicesSet.has(j)) {
                            additions.push(j);
                        }
                        break;
                    }
                }
            }
        }

        for (const a of additions) {
            if (!indicesSet.has(a)) {
                indices.push(a);
                indicesSet.add(a);
            }
        }

        return indices.sort((a, b) => b - a); // descending for safe splice
    }

    // ------------------------------------------------------------------------
    // Summarization
    // ------------------------------------------------------------------------

    /**
     * Get the messages eligible for summarization.
     * Keeps the last MIN_KEEP_TAIL messages verbatim (sliding window).
     * Returns the oldest messages that can be compressed.
     *
     * Respects tool-call pair boundaries — never returns a partial pair.
     *
     * If `maxBatchTokens` is provided, returns only a subset that fits within
     * that token budget — enabling chunked summarization when context is nearly full.
     */
    getMessagesToSummarize(maxBatchTokens?: number): ChatCompletionMessage[] {
        // Filter out system messages — they don't count toward the tail
        const nonSystem = this.apiMessages.filter(m => m.role !== 'system');

        // Keep the last N messages verbatim
        if (nonSystem.length <= MIN_KEEP_TAIL) return [];

        let toCompress = nonSystem.slice(0, nonSystem.length - MIN_KEEP_TAIL);

        // Ensure tool-call pairs are complete
        toCompress = this._ensureToolCallPairsComplete(toCompress);

        // If we have a token budget, take only as many oldest messages as fit.
        // Re-check pair integrity after budget slicing.
        if (maxBatchTokens !== undefined && maxBatchTokens > 0) {
            let batchTokens = 0;
            let batchSize = 0;
            for (const msg of toCompress) {
                const msgTokens = this._messageTokenCount(msg);
                if (batchTokens + msgTokens > maxBatchTokens && batchSize > 0) break;
                batchTokens += msgTokens;
                batchSize++;
            }
            toCompress = toCompress.slice(0, batchSize);
            // Re-enforce pair integrity after budget cut
            toCompress = this._ensureToolCallPairsComplete(toCompress);
        }

        return toCompress;
    }

    /** Compute the full token cost of a message including tool_calls. */
    private _messageTokenCount(msg: ChatCompletionMessage): number {
        let count = 1; // role overhead
        if (msg.content) count += ContextManager.countTokens(msg.content);
        if (msg.tool_call_id) count += ContextManager.countTokens(msg.tool_call_id);
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                count += ContextManager.countToolCallTokens(tc);
            }
        }
        return count;
    }

    /**
     * Replace old messages with a summary block.
     * Removes the specified messages (or falls back to getMessagesToSummarize) and inserts a summary note.
     * Optionally appends recently-touched file paths (Qwen Code-style retention).
     *
     * On subsequent calls, replaces the previous summary instead of stacking
     * a new one — preventing permanent ballast accumulation.
     *
     * @param summaryText  The compressed summary text.
     * @param recentFiles  File paths touched during the summarized conversation.
     * @param toRemove     Optional explicit list of messages to remove. When provided, these are the
     *                      exact messages removed — preventing a mismatch when the caller already
     *                      decided the batch size (e.g., compact with a token budget).
     */
    injectSummary(summaryText: string, recentFiles?: string[], toRemove?: ChatCompletionMessage[]): SummaryBlock {
        const messagesToRemove = toRemove ?? this.getMessagesToSummarize();
        if (messagesToRemove.length === 0) {
            throw new Error('No messages to summarize');
        }

        // Build the summary message with optional file retention
        let summaryContent = `## Conversation Summary\n\n${summaryText}`;
        if (recentFiles && recentFiles.length > 0) {
            summaryContent += `\n\n## Recently Modified Files\n\nThe following files were touched during the conversation above. Their current state may have changed since then:\n${recentFiles.map(p => `- ${p}`).join('\n')}`;
        }
        summaryContent += `\n\nThe above is a summary of earlier conversation turns. Continue the conversation from this point.`;

        // role: 'user', not 'system' — many OpenAI-compatible backends
        // (confirmed via a live LiteLLM 400: "System message must be at the
        // beginning") treat that as "at most one system message, and it must
        // be messages[0]," not "system messages must be clustered at the
        // start." A second role:'system' entry at index 1 — exactly what this
        // used to be — is rejected outright, and since sendMessage() always
        // rebuilds apiMessages[0] fresh from the real system prompt on every
        // turn, this summary block persists at index 1 for the rest of the
        // conversation once injected: every subsequent request in a
        // compacted chat would 400. New chats never call injectSummary(), so
        // this was invisible until a chat was actually compacted and then
        // sent another message.
        const summaryMsg: ChatCompletionMessage = {
            role: 'user',
            content: summaryContent,
        };

        // Remove old messages using index-based resolution (handles tool-call pairs)
        const indicesToRemove = this._resolveIndicesWithPairs(messagesToRemove);

        // Remove from apiMessages (iterate reverse to preserve indices)
        for (const idx of indicesToRemove) {
            if (idx >= 0 && idx < this.apiMessages.length) {
                this.apiMessages.splice(idx, 1);
            }
        }

        // Find the original system prompt (always at index 0 after removals of non-system msgs)
        const systemIdx = this.apiMessages.findIndex(m => m.role === 'system');

        // Check if there's already a summary at position systemIdx+1 — replace it
        // instead of stacking a new one. This prevents summary accumulation.
        const summarySlot = systemIdx + 1;
        if (summarySlot < this.apiMessages.length &&
            this.apiMessages[summarySlot].content?.includes('## Conversation Summary')) {
            // Replace existing summary
            this.apiMessages[summarySlot] = summaryMsg;
        } else {
            // Insert new summary after system message
            this.apiMessages.splice(summarySlot, 0, summaryMsg);
        }

        const block: SummaryBlock = {
            summary: summaryText,
            compressedCount: messagesToRemove.length,
            tokenCount: ContextManager.countTokens(summaryContent),
        };

        // Update (not push) the summaries array — keep only the latest
        this.summaries = [block];

        return block;
    }

    /** Get all summary blocks. */
    getSummaries(): SummaryBlock[] {
        return [...this.summaries];
    }

    /**
     * Get a fixed token budget for summarization.
     * Independent of current window usage — the summary request is a separate API call.
     * Scale with window size: larger windows can handle larger summaries.
     * Min 16K, max 32K, or 10% of window for very large windows.
     */
    getMaxSummaryBatchTokens(): number {
        return Math.min(32000, Math.max(16000, Math.floor(this.config.contextWindowSize * 0.1)));
    }

    /**
     * Extract file paths touched by recent tool calls (for retention after compaction).
     * Returns unique paths in reverse chronological order (most recent first).
     */
    getRecentlyTouchedFiles(maxFiles: number = 5): string[] {
        const paths = new Set<string>();

        // Walk backwards through tool messages to find file paths
        for (let i = this.apiMessages.length - 1; i >= 0 && paths.size < maxFiles; i--) {
            const msg = this.apiMessages[i];
            if (msg.role === 'tool' && msg.content) {
                try {
                    const parsed = JSON.parse(msg.content);
                    // Tool results often contain the file path in the output or as a top-level field
                    const filePath = parsed.filePath || parsed.file || parsed.path;
                    if (typeof filePath === 'string') {
                        paths.add(filePath);
                    }
                } catch {
                    // Try regex fallback for file paths in raw content
                    const match = msg.content.match(/(?:file|path|File|Path)[:\s]+(["']?)([\w\/\-\.]+)\1/);
                    if (match) paths.add(match[2]);
                }
            }
            // Also check assistant messages with tool_calls for file paths
            if (msg.role === 'assistant' && msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    try {
                        const args = JSON.parse(tc.function.arguments);
                        const filePath = args.file || args.filePath || args.path || args.file_path;
                        if (typeof filePath === 'string') {
                            paths.add(filePath);
                        }
                    } catch { /* skip malformed args */ }
                }
            }
        }

        return [...paths];
    }

    /**
     * Emergency drop: remove oldest messages until under targetTokens.
     * Respects tool-call pair boundaries — drops assistant+tool results together.
     */
    emergencyDrop(targetTokens: number): number {
        let dropped = 0;
        // P-2: same fix as _trimContext() — track a running total via
        // per-message subtraction instead of calling getContextSize() (a
        // full re-tokenize of every remaining message) on every iteration.
        let runningTokens = this.getContextSize();
        while (this.apiMessages.length > 1 && runningTokens > targetTokens) {
            // Find the next non-system message to drop
            const idx = this.apiMessages.findIndex(m => m.role !== 'system');
            if (idx < 0) break;

            const msg = this.apiMessages[idx];

            // If it's an assistant with tool_calls, also drop matching tool results
            if (this._hasToolCalls(msg)) {
                const callIds = new Set(msg.tool_calls!.map(tc => tc.id));
                // Collect consecutive tool results after this assistant
                let toolEnd = idx + 1;
                while (toolEnd < this.apiMessages.length &&
                       this.apiMessages[toolEnd].role === 'tool' &&
                       this.apiMessages[toolEnd].tool_call_id &&
                       callIds.has(this.apiMessages[toolEnd].tool_call_id!)) {
                    toolEnd++;
                }
                // Drop the whole block: assistant + tool results
                const removedBlock = this.apiMessages.slice(idx, toolEnd);
                this.apiMessages.splice(idx, removedBlock.length);
                for (const removed of removedBlock) {
                    runningTokens -= ContextManager.countMessageTokens(removed);
                }
                dropped += removedBlock.length;
            } else if (msg.role === 'tool') {
                // Orphaned tool result — drop just this one
                this.apiMessages.splice(idx, 1);
                runningTokens -= ContextManager.countMessageTokens(msg);
                dropped++;
            } else {
                // Regular message — drop one
                this.apiMessages.splice(idx, 1);
                runningTokens -= ContextManager.countMessageTokens(msg);
                dropped++;
            }
        }
        return dropped;
    }

    // --- Retrieval integration ---

    /**
     * Add retrieved code chunks as pinned context.
     * Respects token budget — drops lowest-scoring chunks if over budget.
     */
    addRetrievedContext(chunks: RetrievedChunk[]): void {
        this.retrievedChunks = [...chunks];
        this.enforceRetrievalBudget();
    }

    /** Remove a chunk by file path (user unpinned it). */
    removeRetrievedChunk(filePath: string): void {
        this.retrievedChunks = this.retrievedChunks.filter(
            c => c.filePath !== filePath
        );
    }

    /** Get current retrieved chunks. */
    getRetrievedChunks(): RetrievedChunk[] {
        return [...this.retrievedChunks];
    }

    /**
     * Drop all retrieved chunks without touching apiMessages/attachments.
     * Used by ConversationManager.compact() to clear a RAG injection that's
     * baked into the current system message — see that call site's comment
     * for why this needs its own narrow method rather than clearContext().
     */
    clearRetrievedContext(): void {
        this.retrievedChunks = [];
    }

    /**
     * Build system-prompt text from retrieved chunks.
     * Returns empty string if no chunks or budget exceeded.
     */
    buildRetrievedContextPrompt(): string {
        if (this.retrievedChunks.length === 0) return '';

        const parts = this.retrievedChunks.map(c => {
            const ext = c.filePath.split('.').pop() || '';
            return `--- ${c.filePath} (lines ${c.startLine}-${c.endLine}) ---\n\`\`\`${ext}\n${c.text}\n\`\`\``;
        });

        return `Here are relevant files from the codebase to help answer the user's question:\n\n${parts.join('\n\n')}`;
    }

    /**
     * Check how many tokens are available for retrieved context.
     * Budget = contextWindowSize - currentUsage - reservedForResponse.
     */
    getAvailableRetrievalTokens(reservedForResponse: number = 1024): number {
        const used = this.getContextSize();
        const available = this.config.contextWindowSize - used - reservedForResponse;
        return Math.max(0, available);
    }

    /**
     * Drop lowest-scoring chunks until retrieval fits within budget.
     */
    private enforceRetrievalBudget(): void {
        const prompt = this.buildRetrievedContextPrompt();
        const retrievalTokens = ContextManager.countTokens(prompt);
        const available = this.getAvailableRetrievalTokens();

        // If we fit, nothing to do
        if (retrievalTokens <= available) return;

        // Sort by score ascending (worst first), drop one at a time
        const sorted = [...this.retrievedChunks].sort((a, b) => a.score - b.score);
        while (this.retrievedChunks.length > 0) {
            // Drop the worst chunk
            const worst = sorted.shift();
            if (worst) {
                this.retrievedChunks = this.retrievedChunks.filter(
                    c => c.filePath !== worst.filePath
                );
            }

            const newPrompt = this.buildRetrievedContextPrompt();
            if (ContextManager.countTokens(newPrompt) <= available) break;
        }
    }
}
