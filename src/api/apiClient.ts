import * as vscode from 'vscode';
import { ChatConfig, ChatCompletionMessage, NativeToolCall, ParsedToolCall } from '../types';
import { ActiveModelConfig } from '../provider/modelManager';
import { ObservabilityService } from '../observability/observability';
import { ContextManager } from '../context/contextManager';
import { getToolDefinitions } from '../tools/toolDefinitions';
import { selectTools } from '../tools/toolSelection';
import { ToolRegistry } from '../tools/toolRegistry';
import { parseToolCalls } from './toolCallParser';
import { buildSystemPrompt, buildFimPrompt, buildSummarizeBody } from './promptBuilder';
import { DEFAULT_CONTEXT_WINDOW_SIZE } from '../provider/modelManager';
export { TOOL_DEFINITIONS } from '../tools/toolDefinitions';

/** Callback invoked for each streaming text chunk. */
export type StreamChunkCallback = (chunk: string) => void;

export class ApiClient {
    private config: ChatConfig;
    private _observability: ObservabilityService | null = null;
    private _scopedRegistry: ToolRegistry | null = null;

    constructor(config: ChatConfig) {
        this.config = config;
    }

    /** Attach an observability service for request logging. */
    setObservability(obs: ObservabilityService | null): void {
        this._observability = obs;
    }

    /**
     * Set a scoped tool registry to use instead of global tool selection.
     * When set, buildChatBody uses this registry's definitions directly.
     * Pass null to revert to the default selectTools() path.
     */
    setScopedRegistry(registry: ToolRegistry | null): void {
        this._scopedRegistry = registry;
    }

    // --- Static helpers (delegate to extracted modules) ---

    static getConfig(): ChatConfig {
        const config = vscode.workspace.getConfiguration('codeon');
        return {
            modelEndpoint: '',
            modelName: '',
            apiKey: '',
            // P6-T16: context window moved from a single global VS Code setting
            // to a per-model field (set at add/edit time, see ModelManager).
            // This is only the fallback used before any model is configured —
            // mergeConfig() below always prefers the active model's own value.
            contextWindowSize: DEFAULT_CONTEXT_WINDOW_SIZE,
            defaultMode: config.get<string>('defaultMode') || 'plan',
            openCodeEnabled: config.get<boolean>('openCodeEnabled') ?? true,
            openCodeApiKey: config.get<string>('openCodeApiKey') || '',
            temperature: config.get<number>('temperature') ?? 0.7,
            topP: config.get<number>('topP') ?? 0.8,
            topK: config.get<number>('topK') ?? 20,
            presencePenalty: config.get<number>('presencePenalty') ?? 1.5,
            repetitionPenalty: config.get<number>('repetitionPenalty') ?? 1.0,
            minP: config.get<number>('minP') ?? 0.0,
        };
    }

    /** Create a config by merging base settings with an active model override. */
    static mergeConfig(base: ChatConfig, activeModel?: ActiveModelConfig): ChatConfig {
        if (!activeModel) return base;
        return {
            ...base,
            modelEndpoint: activeModel.modelEndpoint || base.modelEndpoint,
            modelName: activeModel.modelName || base.modelName,
            apiKey: activeModel.apiKey || base.apiKey,
            // Per-model context window (P6-T16) — different models genuinely
            // have different limits, so the active model's value always wins
            // over the generic base/default when present.
            contextWindowSize: activeModel.contextWindowSize || base.contextWindowSize,
        };
    }

    static buildSystemPrompt(mode: string): string {
        return buildSystemPrompt(mode);
    }

    static getToolDefinitions() {
        return getToolDefinitions();
    }

    // --- HTTP transport ---

    private getChatCompletionsUrl(): string {
        const base = this.config.modelEndpoint.replace(/\/+$/, '');
        if (base.endsWith('/v1')) {
            return `${base}/chat/completions`;
        }
        return `${base}/v1/chat/completions`;
    }

    /** Maximum number of automatic retries for interrupted streams. */
    private readonly _maxRetries = 2;

    /** HTTP status codes worth retrying (transient server/rate-limit failures). */
    private static readonly RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

    /**
     * Exponential backoff with jitter (P5-T13). Honors a Retry-After header
     * (seconds) when the server supplied one, which is the correct wait for a
     * 429. attempt is 1-based for the delay that precedes it.
     */
    private _backoffMs(attempt: number, retryAfterSec?: number): number {
        if (retryAfterSec && retryAfterSec > 0) {
            return Math.min(retryAfterSec * 1000, 30_000);
        }
        const base = Math.min(500 * 2 ** (attempt - 1), 8_000);
        const jitter = Math.random() * 250;
        return base + jitter;
    }

    async sendMessageStreaming(
        messages: ChatCompletionMessage[],
        mode: string,
        toolsEnabled: boolean,
        onChunk: StreamChunkCallback,
        abortSignal?: AbortSignal
    ): Promise<{ content: string; toolCalls: ParsedToolCall[]; nativeToolCalls?: NativeToolCall[]; streamInterrupted?: boolean }> {
        if (!this.config.apiKey) {
            throw new Error('API key is not configured. Use "Configure Providers & Models" in the command palette to set up a model provider.');
        }

        // P-2/P-3/P-4: computed once, reused for max_tokens AND every
        // recordRequest() call below — see estimateMessagesTokens().
        const estimatedInputTokens = this.estimateMessagesTokens(messages);
        const body = this.buildChatBody(messages, toolsEnabled, true, estimatedInputTokens);

        const obs = this._observability;
        const requestStart = Date.now();
        let firstTokenTime = 0;
        const onObsChunk: StreamChunkCallback = (chunk: string) => {
            if (firstTokenTime === 0) firstTokenTime = Date.now() - requestStart;
            onChunk(chunk);
        };

        // Backoff to apply at the top of the next iteration (set before `continue`).
        let pendingBackoffMs = 0;
        // Partial text captured from an interrupted stream, so an exhausted-retry
        // return can hand it back instead of '' (P5-T13).
        let lastPartialContent = '';

        for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
            if (attempt > 0) {
                console.warn(`[ApiClient] Retrying stream (attempt ${attempt}/${this._maxRetries}, backoff ${Math.round(pendingBackoffMs)}ms)`);
                await new Promise(r => setTimeout(r, pendingBackoffMs));
                // Check if user aborted during backoff
                if (abortSignal?.aborted) {
                    throw new DOMException('Aborted by user', 'AbortError');
                }
            }

            try {
                const response = await fetch(this.getChatCompletionsUrl(), {
                    method: 'POST',
                    headers: this.authHeaders(),
                    body: JSON.stringify(body),
                    signal: abortSignal
                });

                if (!response.ok) {
                    const raw = await response.text();

                    // Certain 400 errors are unrecoverable — do NOT fall back to
                    // non-streaming because it just re-sends the same broken payload.
                    // Examples: "No user query found", invalid model name, malformed messages.
                    const isUnrecoverable400 = response.status === 400 &&
                        (raw.includes('No user query') ||
                         raw.includes('invalid_parameter_value') ||
                         raw.includes('malformed'));

                    if ((response.status === 400 || response.status === 403 || response.status === 405) && !isUnrecoverable400) {
                        return this.sendMessageNonStreaming(messages, toolsEnabled, abortSignal);
                    }

                    // P5-T13: retry transient rate-limit / server errors (429, 5xx)
                    // with backoff instead of killing the turn on the first hit.
                    if (ApiClient.RETRYABLE_STATUS.has(response.status) && attempt < this._maxRetries) {
                        const retryAfterHeader = response.headers.get('retry-after');
                        const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : undefined;
                        pendingBackoffMs = this._backoffMs(attempt + 1, Number.isFinite(retryAfterSec) ? retryAfterSec : undefined);
                        obs?.recordRequest({
                            model: this.config.modelName,
                            latencyMs: Date.now() - requestStart,
                            ttftMs: 0,
                            inputTokens: estimatedInputTokens,
                            outputTokens: 0,
                            toolCallCount: 0,
                            httpStatus: response.status,
                            error: `HTTP ${response.status} (retrying): ${raw.slice(0, 200)}`,
                        });
                        continue;
                    }

                    obs?.recordRequest({
                        model: this.config.modelName,
                        latencyMs: Date.now() - requestStart,
                        ttftMs: 0,
                        inputTokens: estimatedInputTokens,
                        outputTokens: 0,
                        toolCallCount: 0,
                        httpStatus: response.status,
                        error: `HTTP ${response.status}: ${raw.slice(0, 200)}`,
                    });

                    throw new Error(`LLM API error ${response.status}: ${raw.slice(0, 500)}`);
                }

                const result = await this.readSSEStream(response, onObsChunk, abortSignal);

                obs?.recordRequest({
                    model: this.config.modelName,
                    latencyMs: Date.now() - requestStart,
                    ttftMs: firstTokenTime,
                    inputTokens: estimatedInputTokens,
                    outputTokens: ContextManager.countTokens(result.content),
                    toolCallCount: result.toolCalls.length,
                    httpStatus: response.status,
                    error: null,
                });

                return result;
            } catch (err) {
                const errMsg = (err as Error).message || String(err);

                // Never retry user-initiated aborts
                if ((err as Error).name === 'AbortError') {
                    obs?.recordRequest({
                        model: this.config.modelName,
                        latencyMs: Date.now() - requestStart,
                        ttftMs: 0,
                        inputTokens: estimatedInputTokens,
                        outputTokens: 0,
                        toolCallCount: 0,
                        httpStatus: 0,
                        error: errMsg,
                    });
                    throw err;
                }

                // Capture any partial text the stream produced before failing (P5-T13).
                const partial = (err as Error & { partialContent?: string }).partialContent;
                if (typeof partial === 'string' && partial.length > 0) {
                    lastPartialContent = partial;
                }

                // Retry on network/stream errors
                const isRetryable = errMsg.includes('ECONNRESET') ||
                    errMsg.includes('ERR_') ||
                    errMsg.includes('network') ||
                    errMsg.toLowerCase().includes('interrupt');

                if (isRetryable && attempt < this._maxRetries) {
                    console.warn(`[ApiClient] Stream interrupted, will retry: ${errMsg}`);
                    pendingBackoffMs = this._backoffMs(attempt + 1);
                    continue; // go to next attempt
                }

                // Not retryable or exhausted retries — report and throw
                obs?.recordRequest({
                    model: this.config.modelName,
                    latencyMs: Date.now() - requestStart,
                    ttftMs: 0,
                    inputTokens: estimatedInputTokens,
                    outputTokens: 0,
                    toolCallCount: 0,
                    httpStatus: 0,
                    error: errMsg,
                });

                // If we received tokens but the stream failed, return the partial
                // content (marked interrupted) so the conversation can continue and
                // the persisted history matches what the user already saw stream in.
                if (firstTokenTime > 0 && attempt >= this._maxRetries) {
                    return { content: lastPartialContent, toolCalls: [], nativeToolCalls: [], streamInterrupted: true };
                }

                throw err;
            }
        }

        // Exhausted all retries — hand back any partial text we captured.
        return { content: lastPartialContent, toolCalls: [], nativeToolCalls: [], streamInterrupted: true };
    }

    /**
     * Race a stream read against an abort signal, cancelling the body on abort.
     * L-6: the abort listener is now always removed once the race settles
     * (via finally) — previously it was only cleaned up implicitly when the
     * abort event itself fired (`{once:true}`), so every read that won the
     * race by returning data first left its listener attached to the signal
     * for the lifetime of that AbortController. This is called once per SSE
     * chunk during a stream, so it was a real, fast-accumulating leak per
     * request, not a one-off.
     */
    private async _readWithAbort(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        signal: AbortSignal
    ): Promise<ReadableStreamReadResult<Uint8Array>> {
        if (signal.aborted) {
            throw new DOMException('Aborted by user', 'AbortError');
        }
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
            onAbort = () => reject(new DOMException('Aborted by user', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([reader.read(), abortPromise]);
        } finally {
            if (onAbort) signal.removeEventListener('abort', onAbort);
        }
    }

    private async sendMessageNonStreaming(
        messages: ChatCompletionMessage[],
        toolsEnabled: boolean,
        abortSignal?: AbortSignal
    ): Promise<{ content: string; toolCalls: ParsedToolCall[]; nativeToolCalls?: NativeToolCall[] }> {
        const body = this.buildChatBody(messages, toolsEnabled, false);

        const response = await fetch(this.getChatCompletionsUrl(), {
            method: 'POST',
            headers: this.authHeaders(),
            // H-11: previously no signal at all, so Stop couldn't cancel an
            // in-flight non-streaming fallback request (orphaned network
            // request kept running after the user gave up on it).
            signal: abortSignal,
            body: JSON.stringify(body)
        });

        const raw = await response.text();
        if (!response.ok) {
            throw new Error(`LLM API error ${response.status}: ${raw.slice(0, 500)}`);
        }

        return this.parseNonStreamingResponse(raw);
    }

    private buildChatBody(
        messages: ChatCompletionMessage[],
        toolsEnabled: boolean,
        stream: boolean,
        estimatedInputTokens?: number
    ): Record<string, unknown> {
        // Extract last user message for keyword-based tool selection
        const lastUserMessage = findLastUserMessage(messages);

        let tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> | undefined;

        if (toolsEnabled) {
            if (this._scopedRegistry !== null) {
                // Use scoped registry definitions directly (for sub-agent loops)
                tools = this._scopedRegistry.allDefinitions().map(tool => ({
                    type: 'function' as const,
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters
                    }
                }));
            } else {
                // Default path: keyword-based tool selection from global registry
                tools = selectTools(lastUserMessage).map(tool => ({
                    type: 'function' as const,
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters
                    }
                }));
            }
        }

        const body: Record<string, unknown> = {
            model: this.config.modelName,
            messages,
            max_tokens: this.computeMaxTokens(messages, estimatedInputTokens),
            temperature: this.config.temperature,
            top_p: this.config.topP,
            top_k: this.config.topK > 0 ? this.config.topK : undefined,
            presence_penalty: this.config.presencePenalty,
            repetition_penalty: this.config.repetitionPenalty,
            min_p: this.config.minP,
            stream
        };

        // Remove undefined values so they don't override server defaults
        Object.keys(body).forEach(key => { if (body[key] === undefined) delete body[key]; });

        if (tools) {
            body.tools = tools;
            body.tool_choice = 'auto';
        }

        return body;
    }

    private authHeaders(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
        };
    }

    /**
     * Compute max_tokens so that inputTokens + max_tokens <= contextWindowSize.
     * This prevents ContextWindowExceeded errors from the LLM API.
     *
     * The contextWindowSize setting represents the model's TOTAL context window
     * (e.g., 128000 or 196608). We cap the output at a reasonable maximum
     * (default 20000) and further reduce it if the conversation is already long.
     */
    /**
     * P-4/P-2/P-3: the single, canonical per-message token estimate — reused
     * for both computeMaxTokens() and the observability recordRequest() calls
     * in sendMessageStreaming(), instead of each computing its own count
     * independently. Previously a single API call could re-tokenize the full
     * messages array up to ~6 times (this reduce here, once for max_tokens,
     * plus up to 5 separate `ContextManager.countTokens(JSON.stringify(messages))`
     * calls across the retry/error/success paths in sendMessageStreaming) —
     * real, non-trivial tiktoken work repeated for no benefit, and the two
     * differently-shaped counts (per-field reduce vs. JSON.stringify-the-whole-array)
     * could disagree slightly, which is exactly the "duplicate token counting"
     * finding. Callers should compute this once per request and pass it
     * around rather than calling it again.
     */
    private estimateMessagesTokens(messages: ChatCompletionMessage[]): number {
        return messages.reduce((sum, m) => {
            let tokens = m.content ? ContextManager.countTokens(m.content) : 0;
            if (m.tool_calls) {
                for (const tc of m.tool_calls) {
                    tokens += ContextManager.countTokens(JSON.stringify(tc));
                }
            }
            if (m.tool_call_id) {
                tokens += ContextManager.countTokens(m.tool_call_id);
            }
            return sum + tokens;
        }, 0);
    }

    private computeMaxTokens(messages: ChatCompletionMessage[], estimatedInputTokens?: number): number {
        // Reasonable ceiling for a single response — even if the context window
        // is huge, we don't want to request 100K output tokens.
        const maxOutputCeiling = 20000;

        const inputTokens = estimatedInputTokens ?? this.estimateMessagesTokens(messages);

        // Reserve tokens for system prompt overhead
        const reserved = 256;

        // How much room is left in the context window after input?
        const remainingInWindow = this.config.contextWindowSize - inputTokens - reserved;

        // Use the smaller of: the configured ceiling, or what fits in the window
        return Math.max(512, Math.min(maxOutputCeiling, remainingInWindow));
    }

    private async readSSEStream(
        response: Response,
        onChunk: StreamChunkCallback,
        abortSignal?: AbortSignal
    ): Promise<{ content: string; toolCalls: ParsedToolCall[]; nativeToolCalls?: NativeToolCall[] }> {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';

        const toolCallDeltas: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
        }> = [];

        try {
            let done: boolean;
            let value: Uint8Array | undefined;
            while (true) {
                // Check abort before each read
                if (abortSignal?.aborted) {
                    throw new DOMException('Aborted by user', 'AbortError');
                }

                // Race reader.read() against abort signal
                const result = abortSignal
                    ? await this._readWithAbort(reader, abortSignal)
                    : await reader.read();
                done = result.done;
                value = result.value!;

                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed === '' || trimmed === 'data: [DONE]') continue;
                    if (!trimmed.startsWith('data:')) continue;

                    const jsonStr = trimmed.slice(5).trim();
                    if (!jsonStr) continue;

                    try {
                        const parsed = JSON.parse(jsonStr);
                        const delta = parsed.choices?.[0]?.delta;
                        if (!delta) continue;

                        if (delta.content) {
                            fullContent += delta.content;
                            onChunk(delta.content);
                        }

                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index;
                                if (!toolCallDeltas[idx]) {
                                    toolCallDeltas[idx] = {
                                        id: tc.id || '',
                                        type: tc.type || 'function',
                                        function: { name: '', arguments: '' }
                                    };
                                }
                                const acc = toolCallDeltas[idx];
                                if (tc.id) acc.id = tc.id;
                                if (tc.type) acc.type = tc.type;
                                if (tc.function?.name) acc.function.name += tc.function.name;
                                if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
                            }
                        }
                    } catch { /* skip malformed */ }
                }
            }
        } catch (e) {
            // Cancel the response body to free the socket on abort
            response.body?.cancel();
            // P5-T13: attach whatever text had already streamed so the caller can
            // preserve it instead of returning content:'' after the UI already
            // rendered it live via onChunk. (Not set for user aborts — those are
            // handled separately and shouldn't surface partial text as a result.)
            if ((e as Error).name !== 'AbortError') {
                (e as Error & { partialContent?: string }).partialContent = fullContent;
            }
            throw e;
        } finally {
            reader.releaseLock();
        }

        // P5-T13/T14: a tool-call delta that never received an `id` can't be
        // matched to a tool result and would be silently dropped. Some providers
        // only send `id` on the first delta for an index — if it's genuinely
        // absent, synthesize a stable id from the index rather than discarding a
        // real tool call, and warn so the gap is observable rather than invisible.
        for (let i = 0; i < toolCallDeltas.length; i++) {
            const tc = toolCallDeltas[i];
            if (tc && tc.id.length === 0 && (tc.function.name || tc.function.arguments)) {
                tc.id = `call_synth_${i}`;
                console.warn(`[SSE] Tool-call delta at index ${i} (${tc.function.name || 'unnamed'}) had no id; synthesized '${tc.id}' to avoid dropping it.`);
            }
        }

        const nativeToolCalls: NativeToolCall[] = toolCallDeltas
            .filter(tc => tc && tc.id.length > 0)
            .map(tc => {
                // Validate and repair malformed arguments (truncated SSE stream)
                let args = tc.function.arguments;
                try {
                    JSON.parse(args);
                } catch {
                    console.warn(`[SSE] Malformed arguments for ${tc.function.name}, repairing: ${args.slice(0, 120)}...`);
                    // Try to fix common truncation issues
                    const trimmed = args.trim();
                    let repaired = false;

                    // Missing closing brace
                    if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
                        args = trimmed + '}';
                        try { JSON.parse(args); repaired = true; } catch {}
                    }

                    // If still broken, try closing unclosed strings first, then the brace
                    if (!repaired && trimmed.startsWith('{')) {
                        const closed = trimmed.replace(/"([^"\\]*(\\.[^"\\]*)*)$/g, '"$1"}');
                        try { args = closed; JSON.parse(args); repaired = true; } catch {}
                    }

                    // Last resort: try adding '}'
                    if (!repaired && trimmed.startsWith('{')) {
                        args = trimmed + '}';
                        try { JSON.parse(args); repaired = true; } catch {}
                    }

                    if (!repaired) {
                        console.error(`[SSE] Could not repair arguments for ${tc.function.name}: ${args.slice(0, 60)}...`);
                        args = '{}';
                    }
                }
                return { id: tc.id, type: tc.type, function: { name: tc.function.name, arguments: args } };
            });
        const toolCalls = parseToolCalls(fullContent, nativeToolCalls);

        return { content: fullContent, toolCalls, nativeToolCalls };
    }

    private parseNonStreamingResponse(raw: string): { content: string; toolCalls: ParsedToolCall[]; nativeToolCalls?: NativeToolCall[] } {
        const data = JSON.parse(raw) as {
            choices?: Array<{
                message?: {
                    content?: string | null;
                    tool_calls?: Array<{
                        id: string;
                        type: string;
                        function: { name: string; arguments: string };
                    }>;
                };
            }>;
        };

        const choice = data.choices?.[0];
        const message = choice?.message;
        const content = message?.content || '';

        // Validate native tool call arguments from non-streaming response
        const validatedNativeToolCalls = message?.tool_calls?.map(tc => {
            let args = tc.function.arguments || '';
            try { JSON.parse(args); } catch {
                console.warn(`[Non-stream] Malformed arguments for ${tc.function.name}, repairing`);
                const trimmed = args.trim();
                if (trimmed.startsWith('{') && !trimmed.endsWith('}')) {
                    args = trimmed + '}';
                    try { JSON.parse(args); } catch { args = '{}'; }
                } else {
                    args = '{}';
                }
            }
            return { id: tc.id, type: tc.type, function: { name: tc.function.name, arguments: args } };
        });

        const toolCalls = parseToolCalls(content, validatedNativeToolCalls);

        return { content, toolCalls, nativeToolCalls: validatedNativeToolCalls };
    }

    // --- Completion (autocomplete) ---

    async sendCompletionRequest(
        prefix: string,
        suffix: string,
        model?: string
    ): Promise<string> {
        if (!this.config.apiKey) {
            throw new Error('API key is not configured.');
        }

        const fimPrompt = buildFimPrompt(prefix, suffix);

        const body: Record<string, unknown> = {
            model: model || this.config.modelName,
            messages: [{ role: 'user', content: fimPrompt }],
            max_tokens: 50,
            temperature: 0.1,
            stream: false
        };

        const response = await fetch(this.getChatCompletionsUrl(), {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify(body)
        });

        const raw = await response.text();
        if (!response.ok) {
            console.warn(`Autocomplete API error ${response.status}: ${raw.slice(0, 200)}`);
            return '';
        }

        const data = JSON.parse(raw) as {
            choices?: Array<{ message?: { content?: string | null } }>;
        };

        return (data.choices?.[0]?.message?.content || '').trim();
    }

    // --- Summarization ---

    async summarizeConversation(messages: ChatCompletionMessage[], abortSignal?: AbortSignal): Promise<string> {
        if (!this.config.apiKey) {
            throw new Error('API key is not configured.');
        }

        // C4: Cache-aware summary request.
        // Build the body using the conversation's own message structure so that
        // if prompt caching is supported by the provider, the prefix hits cache.
        const summarizeBody = buildSummarizeBody(messages);

        // Adaptive summary budget: ~8% of context window (Claude-style).
        // For 128K → 10240 tokens, for 196K → 15616 tokens, capped at 16384.
        const summaryBudget = Math.min(16384, Math.max(4096, Math.floor(this.config.contextWindowSize * 0.08)));

        const body: Record<string, unknown> = {
            model: this.config.modelName,
            messages: summarizeBody.messages,
            max_tokens: summaryBudget,
            temperature: 0.3,
            stream: false,
        };

        try {
            const response = await fetch(this.getChatCompletionsUrl(), {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify(body),
                signal: abortSignal,
            });

            const raw = await response.text();
            if (!response.ok) {
                console.warn(`Summarization API error ${response.status}: ${raw.slice(0, 200)}`);
                return '';
            }

            const data = JSON.parse(raw) as {
                choices?: Array<{ message?: { content?: string | null } }>;
            };

            return (data.choices?.[0]?.message?.content || '').trim();
        } catch (err) {
            // Aborted (Stop clicked, or a chat switch during compact()) is
            // expected, not a real failure — don't spam the console for it.
            if ((err as Error)?.name !== 'AbortError') {
                console.warn('Summarization request failed:', err);
            }
            return '';
        }
    }
    /**
     * Generate an embedding vector for the given text.
     * Uses the OpenAI-compatible /v1/embeddings endpoint.
     * Returns null if the provider doesn't support embeddings.
     */
    async generateEmbedding(text: string): Promise<number[] | null> {
        if (!this.config.apiKey) return null;

        const base = this.config.modelEndpoint.replace(/\/+$/, '');
        const url = base.endsWith('/v1') ? `${base}/embeddings` : `${base}/v1/embeddings`;
        const model = this.config.embeddingModel || 'text-embedding-3-small';

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({ model, input: text }),
            });

            if (!response.ok) {
                // Provider doesn't support embeddings — not an error, just unavailable
                return null;
            }

            const data = await response.json() as {
                data?: Array<{ embedding: number[] }>;
            };

            return data.data?.[0]?.embedding || null;
        } catch {
            return null;
        }
    }
}

/**
 * Find the last user message content from the conversation history.
 * Used for keyword-based tool selection.
 */
function findLastUserMessage(messages: ChatCompletionMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && messages[i].content) {
            return messages[i].content;
        }
    }
    return '';
}
