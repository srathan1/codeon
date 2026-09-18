import { ChatCompletionMessage, NativeToolCall } from '../types';
import { ApiClient, StreamChunkCallback } from '../api/apiClient';
import { ContextManager } from '../context/contextManager';
import { toolRegistry } from '../tools/toolRegistry';
import { ActiveModelConfig } from '../provider/modelManager';
import { ChatConfig } from '../types';

/**
 * Translate known backend error signatures into an actionable message instead
 * of a raw passthrough (defense-in-depth). The primary fix is that the seed
 * task message can no longer be compacted away (see seedUserMessage below),
 * so this specific "No user query" case should no longer occur in practice —
 * but if any backend/provider produces the equivalent failure through some
 * other path, the agent should say what happened instead of surfacing
 * litellm/OpenAI internals.
 */
function friendlyErrorMessage(raw: string): string {
    if (/no user query/i.test(raw)) {
        return `Sub-agent context error: the conversation sent to the model had no user message left (likely lost during context compaction). This should not happen after the P6-T15 fix — if you see this, please report it. Original error: ${raw}`;
    }
    return raw;
}

/**
 * Events streamed from a sub-agent loop back to the parent.
 */
export interface SubAgentProgressEvent {
    type: 'tool_call' | 'tool_result' | 'text_chunk' | 'turn_start' | 'completed' | 'error' | 'timeout' | 'partial_output';
    toolName?: string;
    toolId?: string;
    output?: string;
    text?: string;
    turn?: number;
    error?: string;
}

/**
 * Configuration for running a sub-agent loop.
 */
export interface SubAgentOptions {
    systemPrompt: string;
    userMessage: string;
    toolAllowlist: string[];
    maxTurns?: number;
    timeoutMs?: number;
    onProgress?: (event: SubAgentProgressEvent) => void;
    abortSignal?: AbortSignal;
    /** Override the active model config (endpoint/key/name). If omitted, uses current settings. */
    modelConfig?: ActiveModelConfig;
    /**
     * Callback that returns pending messages injected by send_agent_message.
     * The loop drains this between turns — returned strings are consumed.
     */
    onDrainMessages?: () => string[];
    /**
     * Route tool execution through the parent conversation's own guardrails
     * (risk classification, approval, audit logging, auto-checkpoint) instead
     * of dispatching straight to the scoped executor (P6-T14). Supplied by
     * SpawnAgentExecutor from the parent's ToolCallHandler. When omitted (e.g.
     * in unit tests that construct SubAgentLoop directly), falls back to the
     * older direct-dispatch path — the allowlist check applies either way.
     */
    executeTool?: (name: string, args: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>;
}

/**
 * Result of a completed sub-agent run.
 */
export interface SubAgentResult {
    success: boolean;
    output: string;
    toolCalls: number;
    turns: number;
    durationMs: number;
    error?: string;
}

/**
 * Self-contained LLM loop for running a sub-agent with restricted tools.
 *
 * Creates its own ApiClient with a scoped tool registry and runs an
 * independent conversation loop. All communication with the caller goes
 * through the onProgress callback — no webview posting, no chatStore saves,
 * no contextManager, no retrievalService.
 *
 * Context lifecycle:
 * - Own messages[] array, entirely separate from the parent's apiMessages.
 * - Token budget enforced per-turn via trimIfNeeded() (truncates + drops).
 * - Auto-summarization when context exceeds 85% (calls summarizeConversation).
 * - Only final output enters the parent context (via wait_for_agent result).
 */
export class SubAgentLoop {
    public async run(options: SubAgentOptions): Promise<SubAgentResult> {
        const startTime = Date.now();

        // Dynamic maxTurns: scale with tool count and prompt length.
        // Base: 10 turns for simple read-only tasks. Add 3 turns per extra tool.
        // Cap at 40 to prevent runaway loops. Clamp to caller-provided override.
        const toolCount = options.toolAllowlist.length;
        const promptWords = options.userMessage.split(/\s+/).length;
        const baseTurns = Math.min(40, 10 + toolCount * 3 + (promptWords > 50 ? 5 : 0));
        const maxTurns = options.maxTurns ?? baseTurns;

        // Dynamic timeout: 2 min base + 1 min per tool, capped at 10 min.
        const baseTimeout = Math.min(600_000, 120_000 + toolCount * 60_000);
        const timeoutMs = options.timeoutMs ?? baseTimeout;

        const onProgress = options.onProgress;

        // Build API client with merged config
        const baseConfig = ApiClient.getConfig();
        const mergedConfig: ChatConfig = {
            ...baseConfig,
            ...(options.modelConfig ? {
                modelEndpoint: options.modelConfig.modelEndpoint || baseConfig.modelEndpoint,
                modelName: options.modelConfig.modelName || baseConfig.modelName,
                apiKey: options.modelConfig.apiKey || baseConfig.apiKey,
            } : {}),
        };
        const apiClient = new ApiClient(mergedConfig);

        // Set up scoped tool registry
        const scopedRegistry = toolRegistry.createSubset(options.toolAllowlist);
        apiClient.setScopedRegistry(scopedRegistry);

        // Initialize messages — this is the sub-agent's OWN context window,
        // entirely separate from the parent conversation's apiMessages.
        const messages: ChatCompletionMessage[] = [
            { role: 'system', content: options.systemPrompt },
            { role: 'user', content: options.userMessage },
        ];

        // The sub-agent's seed task message — captured by identity (not index,
        // since compaction can insert/remove messages around it) so compaction
        // can permanently exclude it from being dropped or summarized away.
        // Bug this fixes: unlike the main conversation (which gets a fresh user
        // message every turn), a sub-agent gets exactly ONE user message ever.
        // If compaction removes it, the message array permanently has zero
        // 'user'-role entries, and every subsequent API call fails with a hard,
        // unrecoverable 400 ("No user query found in messages") for the rest of
        // the agent's run — it can never recover, because nothing ever adds a
        // user message back.
        const seedUserMessage = messages[1];

        let totalToolCalls = 0;
        let aggregatedOutput = '';

        // Lightweight context budget for sub-agents: keep tool results short
        // and drop oldest messages when approaching the window limit.
        const windowSize = mergedConfig.contextWindowSize;
        const maxToolResultChars = 3000;
        // Track how many times we've auto-summarized to avoid thrash
        let compactCount = 0;
        const maxAutoCompactions = 2;

        function estimateTokens(msgs: ChatCompletionMessage[]): number {
            return msgs.reduce((sum, m) => {
                let t = m.content ? ContextManager.countTokens(m.content) : 0;
                if (m.tool_calls) {
                    for (const tc of m.tool_calls) {
                        t += ContextManager.countTokens(JSON.stringify(tc));
                    }
                }
                return sum + t;
            }, 0);
        }

        /**
         * Check whether a message is an assistant with tool_calls.
         */
        function hasToolCalls(msg: ChatCompletionMessage): boolean {
            return msg.role === 'assistant' && !!msg.tool_calls && msg.tool_calls.length > 0;
        }

        /**
         * Ensure we never orphan a tool-call pair when dropping messages.
         * If we'd drop an assistant-with-tool_calls without its tool results,
         * skip it. If we'd drop a tool result without its parent assistant,
         * include the parent too.
         */
        function dropSafe(idx: number): number {
            // Returns the count of messages actually removed starting from idx.
            const msg = messages[idx];
            if (!msg) return 0;

            if (hasToolCalls(msg)) {
                // Drop this assistant AND its matching tool results
                const callIds = new Set(msg.tool_calls!.map(tc => tc.id));
                let dropCount = 1;
                for (let j = idx + 1; j < messages.length && dropCount <= 20; j++) {
                    const tid = messages[j].tool_call_id;
                    if (messages[j].role === 'tool' && tid && callIds.has(tid)) {
                        dropCount++;
                    } else if (messages[j].role === 'tool') {
                        // Tool result for a different call — stop here
                        break;
                    } else {
                        // Non-tool message — stop
                        break;
                    }
                }
                messages.splice(idx, dropCount);
                return dropCount;
            } else if (msg.role === 'tool') {
                // Tool result without parent — find and drop parent assistant too
                const parentId = msg.tool_call_id || '';
                let parentIdx = -1;
                for (let j = idx - 1; j >= 0; j--) {
                    if (messages[j].role === 'assistant' && messages[j].tool_calls?.some(tc => tc.id === parentId)) {
                        parentIdx = j;
                        break;
                    }
                    if (messages[j].role === 'user') break; // stopped searching
                }
                if (parentIdx >= 0) {
                    // Drop parent first (higher index splice would invalidate), then this
                    // Actually: drop from highest index first
                    messages.splice(idx, 1);
                    messages.splice(parentIdx, 1);
                    return 2;
                }
                // No parent found — just drop the orphan tool result
                messages.splice(idx, 1);
                return 1;
            } else {
                // Plain user/system message — safe to drop alone
                messages.splice(idx, 1);
                return 1;
            }
        }

        /**
         * Auto-summarize the sub-agent's own context when it fills up.
         * Uses the same summarizeConversation API as the main thread but
         * operates on the sub-agent's local messages array.
         */
        async function trySummarize(): Promise<boolean> {
            if (compactCount >= maxAutoCompactions) return false; // thrash protection

            // Pick messages to summarize: everything except system, the seed task
            // message, and the last 4 messages. The seed message is excluded from
            // the eligible pool entirely (not just protected by position) — see
            // the comment on seedUserMessage above for why it must never be
            // summarized away.
            const nonSystem = messages.filter(m => m.role !== 'system' && m !== seedUserMessage);
            if (nonSystem.length <= 6) return false; // not enough to compress

            const toCompress = nonSystem.slice(0, nonSystem.length - 4);
            if (toCompress.length === 0) return false;

            try {
                const summary = await apiClient.summarizeConversation(toCompress);
                if (!summary) return false;

                // Remove compressed messages (safe drop)
                const toRemoveSet = new Set(toCompress);
                // Remove from highest index first to preserve lower indices
                const indices: number[] = [];
                for (let i = 0; i < messages.length; i++) {
                    if (toRemoveSet.has(messages[i])) indices.push(i);
                }
                for (let i = indices.length - 1; i >= 0; i--) {
                    messages.splice(indices[i], 1);
                }

                // Insert summary as a system message after the real system prompt
                const summaryMsg: ChatCompletionMessage = {
                    role: 'system',
                    content: `## Earlier Work Summary\n\n${summary}\n\nThe above summarizes earlier tool calls and findings. Continue from this point.`,
                };
                messages.splice(1, 0, summaryMsg);
                compactCount++;

                onProgress?.({
                    type: 'tool_result',
                    toolName: 'auto_summarize',
                    output: `Summarized ${toCompress.length} messages (${ContextManager.countTokens(summary)} tokens)`,
                });

                return true;
            } catch (err) {
                console.warn('[SubAgentLoop] Summarization failed:', err);
                return false;
            }
        }

        /**
         * Enforce context budget before each API call.
         * Three-phase approach: truncate → summarize → emergency drop.
         */
        async function trimIfNeeded(): Promise<void> {
            const tokens = estimateTokens(messages);
            if (tokens <= windowSize * 0.75) return; // plenty of room

            // Phase 1: truncate oversized tool results (free, no API call)
            for (let i = 0; i < messages.length; i++) {
                const msg = messages[i];
                if (msg.role === 'tool' && msg.content && msg.content.length > maxToolResultChars) {
                    try {
                        const parsed = JSON.parse(msg.content);
                        if (parsed.output && typeof parsed.output === 'string' && parsed.output.length > maxToolResultChars) {
                            parsed.output = `[Truncated from ${parsed.output.length} chars]\n${parsed.output.slice(-maxToolResultChars)}`;
                            messages[i] = { ...msg, content: JSON.stringify(parsed) };
                        }
                    } catch {
                        messages[i] = { ...msg, content: `[Truncated]\n${msg.content.slice(-maxToolResultChars)}` };
                    }
                }
            }

            // Re-check after truncation
            if (estimateTokens(messages) <= windowSize * 0.75) return;

            // Phase 2: try auto-summarization if over 80%
            if (tokens > windowSize * 0.8 && compactCount < maxAutoCompactions) {
                const summarized = await trySummarize();
                if (summarized && estimateTokens(messages) <= windowSize * 0.75) return;
            }

            // Phase 3: emergency drop — remove oldest non-system messages safely.
            // Excludes the seed task message by identity: it must survive even
            // emergency drop, or the array permanently loses its only 'user'
            // message (see the comment on seedUserMessage above).
            while (estimateTokens(messages) > windowSize * 0.65 && messages.length > 2) {
                const idx = messages.findIndex(m => m.role !== 'system' && m !== seedUserMessage);
                if (idx < 0) break; // nothing left to drop except system + the seed message
                dropSafe(idx);
            }
        }

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Sub-agent timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });

        try {
            for (let turn = 0; turn < maxTurns; turn++) {
                // Check abort at start of each turn
                if (options.abortSignal?.aborted) {
                    throw new DOMException('Aborted by parent', 'AbortError');
                }

                // Drain any pending messages injected by send_agent_message
                if (options.onDrainMessages) {
                    const pending = options.onDrainMessages();
                    for (const msg of pending) {
                        messages.push({ role: 'user', content: msg });
                        onProgress?.({
                            type: 'tool_result',
                            toolName: 'parent_message',
                            output: `Received message from parent: ${msg.slice(0, 100)}`,
                        });
                    }
                }

                // Keep context within budget before each API call
                await trimIfNeeded();

                onProgress?.({ type: 'turn_start', turn });

                // Send request and collect streaming response
                const onChunk: StreamChunkCallback = (chunk: string) => {
                    onProgress?.({ type: 'text_chunk', text: chunk, turn });
                };

                const result = await Promise.race([
                    apiClient.sendMessageStreaming(
                        messages,
                        'build',
                        true,
                        onChunk,
                        options.abortSignal
                    ),
                    timeoutPromise,
                ]);

                // If no tool calls, this is the final response
                if (!result.toolCalls || result.toolCalls.length === 0) {
                    const finalText = result.content || '';
                    if (finalText) {
                        aggregatedOutput += (aggregatedOutput ? '\n' : '') + finalText;
                    }
                    // Defensive fallback, same idea as the "max turns" path
                    // below — even with the accumulation above, a run with
                    // zero tool calls and a genuinely empty final message
                    // would otherwise return success:true with output:'',
                    // indistinguishable from a real (if terse) empty answer.
                    const finalOutput = aggregatedOutput || (totalToolCalls > 0
                        ? `Completed ${totalToolCalls} tool call${totalToolCalls === 1 ? '' : 's'} but produced no summary text.`
                        : 'No output produced.');
                    onProgress?.({ type: 'completed', output: finalOutput });
                    return {
                        success: true,
                        output: finalOutput,
                        toolCalls: totalToolCalls,
                        turns: turn + 1,
                        durationMs: Date.now() - startTime,
                    };
                }

                // Has tool calls — append assistant message with tool_calls
                totalToolCalls += result.toolCalls.length;

                // Capture any commentary the model wrote alongside these tool
                // calls (e.g. "Let me check that file..."). Without this,
                // aggregatedOutput only ever held the FINAL (no-tool-call)
                // turn's text — if that last turn came back empty (which
                // happens: a model that considers the tool results
                // self-explanatory may not bother writing a closing summary),
                // the caller got success:true with a completely blank output,
                // even though real tool calls and reasoning happened.
                if (result.content) {
                    aggregatedOutput += (aggregatedOutput ? '\n' : '') + result.content;
                }

                const fallbackToolCalls: NativeToolCall[] = result.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                }));

                messages.push({
                    role: 'assistant',
                    content: result.content || '',
                    tool_calls: fallbackToolCalls,
                });

                // Execute each tool call
                for (const toolCall of result.toolCalls) {
                    // Check abort between tool calls
                    if (options.abortSignal?.aborted) {
                        throw new DOMException('Aborted by parent', 'AbortError');
                    }

                    onProgress?.({
                        type: 'tool_call',
                        toolName: toolCall.name,
                        toolId: toolCall.id,
                        turn,
                    });

                    let toolOutput: string;
                    let toolSuccess: boolean;

                    try {
                        // Enforce the sub-agent's own tool allowlist ourselves —
                        // options.executeTool (when present) dispatches through
                        // the parent's full, unscoped tool registry (P6-T14), so
                        // this check is what keeps a sub-agent from reaching a
                        // tool that wasn't in its allowlist.
                        if (!scopedRegistry.has(toolCall.name)) {
                            toolOutput = `Error: tool '${toolCall.name}' not found in allowed tools`;
                            toolSuccess = false;
                        } else if (options.executeTool) {
                            const execResult = await options.executeTool(toolCall.name, toolCall.arguments);
                            toolOutput = execResult.output || '';
                            toolSuccess = execResult.success;
                            if (execResult.error) {
                                toolOutput = `${toolOutput}${toolOutput ? '\n' : ''}Error: ${execResult.error}`;
                            }
                        } else {
                            const executor = scopedRegistry.getExecutor(toolCall.name)!;
                            const execResult = await executor.execute(toolCall.arguments);
                            toolOutput = execResult.output || '';
                            toolSuccess = execResult.success;
                            if (execResult.error) {
                                toolOutput = `${toolOutput}${toolOutput ? '\n' : ''}Error: ${execResult.error}`;
                            }
                        }
                    } catch (e) {
                        toolOutput = `Execution error: ${(e as Error).message}`;
                        toolSuccess = false;
                    }

                    onProgress?.({
                        type: 'tool_result',
                        toolName: toolCall.name,
                        toolId: toolCall.id,
                        output: toolOutput,
                        turn,
                    });

                    // Append tool result as a tool role message
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify({ success: toolSuccess, output: toolOutput }),
                    });
                }

                // Stream partial output after each turn so wait_for_agent can report progress
                if (aggregatedOutput) {
                    onProgress?.({ type: 'partial_output', output: aggregatedOutput });
                }
            }

            // Exhausted max turns
            onProgress?.({ type: 'completed', output: aggregatedOutput });
            return {
                success: true,
                output: aggregatedOutput || 'Max turns reached.',
                toolCalls: totalToolCalls,
                turns: maxTurns,
                durationMs: Date.now() - startTime,
            };
        } catch (err) {
            const errorMsg = friendlyErrorMessage((err as Error).message || String(err));

            if ((err as Error).name === 'AbortError') {
                // Do NOT emit a 'completed' event here — an abort is not a
                // completion. Emitting 'completed' previously caused the agent
                // record to be marked status='completed', which made
                // wait_for_agent report success (with partial output) for an
                // agent the user had stopped. The caller derives the final
                // 'stopped' status from this result instead.
                return {
                    success: false,
                    output: aggregatedOutput,
                    toolCalls: totalToolCalls,
                    turns: 0,
                    durationMs: Date.now() - startTime,
                    error: 'Aborted by parent',
                };
            }

            onProgress?.({ type: 'error', error: errorMsg });
            return {
                success: false,
                output: aggregatedOutput,
                toolCalls: totalToolCalls,
                turns: 0,
                durationMs: Date.now() - startTime,
                error: errorMsg,
            };
        }
    }
}
