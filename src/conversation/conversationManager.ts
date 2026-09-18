import * as vscode from 'vscode';
import { ApiClient, StreamChunkCallback } from '../api/apiClient';
import { ToolCallHandler } from '../tools/toolCallHandler';
import { ContextManager } from '../context/contextManager';
import { ModeManager } from '../context/modeManager';
import { ChatStore } from '../storage/chatStore';
import { RetrievalService } from '../indexing/retrievalService';
import { ObservabilityService } from '../observability/observability';
import { ChatCompletionMessage, NativeToolCall } from '../types';
import { ActiveModelConfig } from '../provider/modelManager';
import { runVerification, formatVerification } from './verificationMiddleware';
import { getAgentManager } from '../tools/executors/agentOrchestrator';

/** Tokens to reserve for an assistant text response. */
const RESERVE_FOR_TEXT_TURN = 4000;

/** Tokens to reserve for a tool turn (assistant text + tool_calls overhead). */
const RESERVE_FOR_TOOL_TURN = 8000;

/** Maximum consecutive auto-compactions before declaring thrash. */
const MAX_AUTO_COMPACTIONS = 3;

export class ConversationManager {
    /** Chat ID of the current in-flight turn — set at sendMessage entry so
     * partial saves and error-path saves target the correct chat even if
     * the user switches away mid-stream (which changes activeChatId). */
    private _originalChatId: string | null = null;

    // --- Thrash detection state (C5) ---
    private _compactCount = 0;
    private _lastCompactTokenCount = 0;
    private _thrashing = false;

    // --- Transcript separation (C1) ---
    /** Append-only full conversation history. Survives compaction intact. */
    private _transcript: ChatCompletionMessage[] = [];

    constructor(
        private readonly apiMessages: ChatCompletionMessage[],
        private readonly getApiClient: () => ApiClient | null,
        private readonly setApiClient: (client: ApiClient) => void,
        private readonly getToolCallHandler: () => ToolCallHandler | null,
        private readonly setToolCallHandler: (handler: ToolCallHandler) => void,
        private readonly contextManager: ContextManager,
        private readonly modeManager: ModeManager,
        private readonly chatStore: ChatStore,
        private readonly retrievalService: RetrievalService | null,
        private readonly observability: ObservabilityService,
        private readonly getWebviewView: () => vscode.WebviewPanel | undefined,
        private readonly post: (message: Record<string, unknown>) => void,
        private readonly isProcessingGetter: () => boolean,
        private readonly setIsProcessing: (v: boolean) => void,
        private readonly getAbortController: () => AbortController | null,
        private readonly setAbortController: (c: AbortController | null) => void,
        private readonly getActiveChatId: () => string | null,
        private readonly getModelConfig: () => ActiveModelConfig | undefined
    ) {}

    /**
     * P5-T4: has the user switched to a different chat since this turn started?
     * `apiMessages` is a single array shared by reference across every chat and
     * repointed in place on a chat switch, so once the active chat no longer
     * matches the one that started this turn, any further push to `apiMessages`
     * would land in (and corrupt) a *different* conversation's message list.
     * The turn must stop writing at that point. Returns false when there was no
     * original chat id to compare against (nothing to protect).
     */
    private _activeChatChangedSinceTurnStart(): boolean {
        return this._originalChatId !== null && this.getActiveChatId() !== this._originalChatId;
    }

    public async sendMessage(text: string, mode: string): Promise<void> {
        const webviewView = this.getWebviewView();
        if (!webviewView || this.isProcessingGetter()) return;

        // Capture the chat ID at entry so we always save to the right chat
        // even if the user switches away mid-turn (abort changes activeChatId).
        this._originalChatId = this.getActiveChatId();

        this.setIsProcessing(true);
        const abortController = new AbortController();
        this.setAbortController(abortController);
        this.modeManager.switchMode(mode, true);

        this.post({ command: 'showStopBtn' });
        this.post({ command: 'processingState', processing: true });

        const baseConfig = ApiClient.getConfig();
        const activeModel = this.getModelConfig();
        const config = ApiClient.mergeConfig(baseConfig, activeModel);
        const vsconfig = vscode.workspace.getConfiguration('codeon');

        // Apply configurable summarize threshold
        const summarizeThreshold = vsconfig.get<number>('autoSummarizeThreshold') ?? 50;
        this.contextManager.setSummarizeThreshold(summarizeThreshold);

        const apiClient = new ApiClient(config);
        apiClient.setObservability(this.observability);
        this.setApiClient(apiClient);

        // Derive approval threshold from interaction mode (takes precedence over raw approvalThreshold setting)
        const interactionMode = vsconfig.get<string>('interactionMode') || 'ask';
        const thresholdMap: Record<string, string> = { ask: 'safe', autoedit: 'moderate', relaxed: 'dangerous' };
        const approvalThreshold = thresholdMap[interactionMode] || 'safe';

        const toolCallHandler = new ToolCallHandler(
            config.openCodeEnabled,
            approvalThreshold,
            vsconfig.get<number>('commandTimeout') || 30,
            vsconfig.get<string[]>('commandBlocklist') || ['rm -rf', ':(){ :|:};', 'mkfs', 'dd if=']
        );
        toolCallHandler.setWebview(webviewView.webview);
        toolCallHandler.setModelConfig(activeModel);
        toolCallHandler.setAbortController(abortController);
        toolCallHandler.setCurrentMode(mode);
        // P5-T5: scope sub-agents spawned during this turn to the chat that
        // started it, so a chat switch mid-flight can't make a background
        // agent's progress render into a different conversation.
        toolCallHandler.setChatId(this._originalChatId ?? undefined);
        // P6-T14: sub-agent tool calls go through this handler's own guardrails
        // (risk classification, approval, audit, auto-checkpoint) instead of a
        // separate, ungoverned path.
        toolCallHandler.wireSubAgentToolExecution();

        // Initialize workspace-level approval store (required for persistent auto-approval rules)
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            toolCallHandler.initWorkspace(workspaceRoot);
        }

        this.setToolCallHandler(toolCallHandler);

        this.post({ command: 'status', text: '' });

        // Declare these outside try so the catch block can reference them for auto-retry.
        let finalResponse = '';
        let hasStreamedContent = false;
        let streamedContentBuffer = '';

        try {
            // --- Retrieval: find relevant code from index (only in build/research/debug modes) ---
            let retrievedContext = '';
            if (this.retrievalService && text.length >= 3 && !['plan'].includes(mode)) {
                const result = await this.retrievalService.retrieve(text);
                if (result.chunks.length > 0) {
                    this.contextManager.addRetrievedContext(result.chunks);
                    retrievedContext = this.contextManager.buildRetrievedContextPrompt();

                    this.post({
                        command: 'retrievedContext',
                        chunks: result.chunks.map(c => ({
                            filePath: c.filePath,
                            startLine: c.startLine,
                            endLine: c.endLine,
                            score: c.score,
                            source: c.source,
                        })),
                    });
                }
            }

            // Build system prompt, optionally appending retrieved context
            let systemPrompt = ApiClient.buildSystemPrompt(mode);
            if (retrievedContext) {
                systemPrompt += `\n\n${retrievedContext}`;
            }

            if (!this.apiMessages.length) {
                const systemMsg: ChatCompletionMessage = {
                    role: 'system',
                    content: systemPrompt
                };
                this.apiMessages.push(systemMsg);
                this._addToTranscript(systemMsg);
            } else {
                const systemMsg: ChatCompletionMessage = {
                    role: 'system',
                    content: systemPrompt
                };
                this.apiMessages[0] = systemMsg;
                // Update system prompt in transcript too
                if (this._transcript.length > 0) {
                    this._transcript[0] = systemMsg;
                }
            }

            const userMsg: ChatCompletionMessage = { role: 'user', content: text };
            this.apiMessages.push(userMsg);
            this._addToTranscript(userMsg);

            // Sync to contextManager for token counting
            this._syncContext();

            // Token budget check before sending — with response token reservation (C3).
            // Effective usage includes space reserved for the upcoming response so we don't
            // send a request that pushes us over after the response arrives.
            let tokenCount = this.contextManager.getContextSize();
            const windowSize = config.contextWindowSize;
            const effectiveUsage = tokenCount + RESERVE_FOR_TEXT_TURN;

            // Reset thrash state on new user message (new intent = fresh start)
            this._compactCount = 0;
            this._lastCompactTokenCount = 0;
            this._thrashing = false;

            // Summarize conversation history if effective usage exceeds threshold
            if (effectiveUsage > windowSize * 0.75) {
                if (this._thrashing) {
                    // Thrash detected — fall back to emergency drop instead of API call
                    const dropped = this.contextManager.emergencyDrop(windowSize * 0.5);
                    if (dropped > 0) {
                        // See _pullContext()'s doc comment — emergencyDrop()
                        // mutates contextManager's own array; without pulling
                        // it back, this.apiMessages (what actually gets sent
                        // to the API and saved) stays at the pre-drop size,
                        // defeating the entire point of the drop.
                        this._pullContext();
                        this.post({
                            command: 'status',
                            text: `⚠️ Context keeps filling up after compaction. Dropped ${dropped} messages. Consider breaking your task into smaller steps.`,
                        });
                    }
                    tokenCount = this.contextManager.getContextSize();
                } else {
                    await this._summarizeConversation(apiClient);
                    tokenCount = this.contextManager.getContextSize();
                    this._trackCompaction(tokenCount);
                }
            } else if (this.contextManager.shouldSummarize()) {
                // Configurable threshold still applies as a secondary trigger
                await this._summarizeConversation(apiClient);
                tokenCount = this.contextManager.getContextSize();
            }

            // Hard trim if effective usage is still dangerously high
            if (tokenCount + RESERVE_FOR_TOOL_TURN > windowSize * 0.9) {
                this._trimContext(windowSize * 0.85);
                tokenCount = this.contextManager.getContextSize();
            }

            // Emergency drop if trimming wasn't enough
            if (tokenCount + RESERVE_FOR_TOOL_TURN > windowSize * 0.85) {
                const dropped = this.contextManager.emergencyDrop(windowSize * 0.75);
                if (dropped > 0) {
                    this._pullContext(); // See _pullContext()'s doc comment.
                    this.post({
                        command: 'status',
                        text: `Dropped ${dropped} old messages to prevent context overflow`,
                    });
                }
                tokenCount = this.contextManager.getContextSize();
            }

            // Absolute last resort: abort before sending an oversized request.
            // Use effective usage (including reservation) at 90% hard limit.
            if (tokenCount + RESERVE_FOR_TOOL_TURN > windowSize * 0.9) {
                const finalResponse = `⚠️ **Context window exhausted** — the conversation has grown too large (${Math.round(tokenCount / 1000)}K/${Math.round(windowSize / 1000)}K tokens). Use /compact or start a new chat to continue.`;
                this.post({
                    command: 'receiveMessage',
                    text: finalResponse,
                    mode,
                });
                return;
            }

            this.post({
                command: 'tokenCount',
                used: tokenCount,
                limit: windowSize,
                msgCount: this.apiMessages.filter(m => m.role !== 'system').length,
                summaryCount: this.contextManager.getSummaries().length,
            });

            // Save user message to store with auto title — compacted messages + full transcript
            if (this._originalChatId) {
                const firstUserMsg = this.apiMessages.filter(m => m.role === 'user')[0];
                const title = firstUserMsg ? (firstUserMsg.content.slice(0, 60) + (firstUserMsg.content.length > 60 ? '...' : '')) : 'New Chat';
                await this._saveChat(this._originalChatId, title);
            }

            const maxTurnsBase = 25;
            const maxTurnsHard = 50;
            let maxTurns = maxTurnsBase;
            let streamedOutputTokens = 0;
            let lastTokenUpdate = 0;
            // Track consecutive failures to detect stuck loops
            let consecutiveFailures = 0;
            let lastFailureTool = '';

            // Accumulated streamed content for periodic persistence
            let lastSaveTime = 0;

            // Streaming chunk callback
            const onChunk: StreamChunkCallback = (chunk: string) => {
                hasStreamedContent = true;
                streamedContentBuffer += chunk;
                this.post({ command: 'streamChunk', text: chunk });

                streamedOutputTokens += Math.ceil(chunk.length / 4);
                const now = Date.now();
                if (now - lastTokenUpdate > 1000) {
                    const estimatedUsed = this.contextManager.getContextSize() + streamedOutputTokens;
                    this.post({
                        command: 'tokenCount',
                        used: estimatedUsed,
                        limit: windowSize,
                        msgCount: this.apiMessages.filter(m => m.role !== 'system').length,
                        summaryCount: this.contextManager.getSummaries().length,
                    });
                    lastTokenUpdate = now;
                }

                // Save partial stream output every 2 seconds so reload doesn't lose in-progress responses
                if (now - lastSaveTime > 2000 && streamedContentBuffer.trim().length > 50) {
                    lastSaveTime = now;
                    this._savePartialAssistantMessage(streamedContentBuffer);
                }
            };

            // Track how many tool turns happened this conversation
            let toolTurnCount = 0;

            // Per-segment timing for the "Xs · Ytok" caption shown under each
            // AI text segment in chat (not just the final response — the user
            // wants to see something churning after every burst of text, the
            // same way Claude Code shows a duration per turn). Reset at the
            // start of each loop iteration; read again once that iteration's
            // segment is finalized (mid-loop before tool calls, or after the
            // loop for the true final response).
            let segmentStartTime = Date.now();

            for (let turn = 0; turn < maxTurns; turn++) {
                if (this.getAbortController()?.signal.aborted) {
                    throw new DOMException('Aborted by user', 'AbortError');
                }
                // P5-T4: bail if the user switched chats (the chat-switch handler
                // aborts too, but guard here as well since a chat switch is exactly
                // the case where continuing would write into the wrong chat).
                if (this._activeChatChangedSinceTurnStart()) {
                    throw new DOMException('Chat switched during turn', 'AbortError');
                }

                segmentStartTime = Date.now();

                // Show working status before each LLM call (including the first)
                this.post({ command: 'status', text: turn > 0 ? `Thinking... (turn ${toolTurnCount + 1})` : 'Thinking...' });

                const result = await apiClient.sendMessageStreaming(
                    this.apiMessages,
                    mode,
                    config.openCodeEnabled,
                    onChunk,
                    this.getAbortController()?.signal
                );

                // Handle interrupted streams — show banner and post partial content
                if (result.streamInterrupted) {
                    finalResponse = streamedContentBuffer.trim() || '⚠️ Stream was interrupted. Your response may be incomplete.';
                    this._replacePartialWithFinal(finalResponse);
                    const interruptedMsg: ChatCompletionMessage = { role: 'assistant', content: finalResponse };
                    this.apiMessages.push(interruptedMsg);
                    this._addToTranscript(interruptedMsg);
                    this.post({
                        command: 'receiveMessage',
                        text: '\n\n⚠️ **Message was incomplete — stream interrupted.** The response above may be partial. You can ask me to continue or retry.',
                        mode,
                    });
                    break;
                }

                if (result.toolCalls.length === 0) {
                    finalResponse = this.stripToolMarkup(result.content) || 'No response from model.';
                    this._replacePartialWithFinal(result.content || finalResponse);
                    const textMsg: ChatCompletionMessage = { role: 'assistant', content: result.content || finalResponse };
                    this.apiMessages.push(textMsg);
                    this._addToTranscript(textMsg);
                    break;
                }

                toolTurnCount++;

                // Finalize the streamed AI text before tool blocks appear (keeps sequential order).
                // Carries this segment's own duration/tokens (not cumulative)
                // for the caption under this text bubble specifically.
                this.post({
                    command: 'streamEnd',
                    durationMs: Date.now() - segmentStartTime,
                    tokens: ContextManager.countTokens(result.content || ''),
                });

                // Send tool calls to UI individually
                for (const toolCall of result.toolCalls) {
                    this.post({
                        command: 'toolCall',
                        toolId: toolCall.id,
                        toolName: toolCall.name,
                        args: JSON.stringify(toolCall.arguments),
                        status: 'running'
                    });
                }

                if (result.nativeToolCalls) {
                    const sanitizedNativeToolCalls: NativeToolCall[] = result.nativeToolCalls.map(tc => {
                        // Validate arguments is valid JSON; repair if malformed (e.g. truncated SSE stream)
                        let args = tc.function?.arguments || '';
                        try {
                            JSON.parse(args);
                        } catch {
                            console.warn(`Malformed tool call arguments for ${tc.function?.name}: ${args.slice(0, 100)}`);
                            args = '{}';
                        }
                        return {
                            id: tc.id || '',
                            type: tc.type || 'function',
                            function: { name: tc.function?.name || '', arguments: args }
                        };
                    });
                    this._replacePartialWithFinal(result.content || '');
                    const assistantMsg: ChatCompletionMessage = {
                        role: 'assistant',
                        content: result.content || '',
                        tool_calls: sanitizedNativeToolCalls
                    };
                    this.apiMessages.push(assistantMsg);
                    this._addToTranscript(assistantMsg);
                } else if (result.toolCalls.length > 0) {
                    // Qwen-style fallback: store tool calls from parsed results so they render on restore
                    const fallbackToolCalls: NativeToolCall[] = result.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                    }));
                    this._replacePartialWithFinal(result.content || '');
                    const qwenMsg: ChatCompletionMessage = {
                        role: 'assistant',
                        content: result.content || '',
                        tool_calls: fallbackToolCalls
                    };
                    this.apiMessages.push(qwenMsg);
                    this._addToTranscript(qwenMsg);
                } else {
                    this._replacePartialWithFinal(result.content || '');
                    const plainMsg: ChatCompletionMessage = {
                        role: 'assistant',
                        content: result.content || ''
                    };
                    this.apiMessages.push(plainMsg);
                    this._addToTranscript(plainMsg);
                }

                // Execute tool calls
                const toolResults = await toolCallHandler.executeToolCallsBatch(result.toolCalls);

                // P5-T4: executeToolCallsBatch can take arbitrarily long (a slow
                // command, an approval prompt, an agent spawn). If the user
                // switched chats during it, `apiMessages` now points at a
                // different conversation — pushing the tool results below would
                // corrupt it (and orphan the assistant tool_calls message from
                // this turn). Stop the turn instead; the switch handler already
                // snapshot-saved the original chat before aborting.
                if (this._activeChatChangedSinceTurnStart()) {
                    throw new DOMException('Chat switched during tool execution', 'AbortError');
                }

                // Track success/failure per tool name for robust loop detection
                const toolFailureCounts = new Map<string, number>();
                let anySuccess = false;
                for (let i = 0; i < result.toolCalls.length; i++) {
                    const toolCall = result.toolCalls[i];
                    const toolResult = toolResults[i];
                    const toolOutput = toolResult.output || toolResult.error || '';

                    const autoApprovedBy = (toolResult as any).autoApprovedBy;
                    this.post({
                        command: 'toolResult',
                        toolId: toolCall.id,
                        output: toolOutput,
                        success: toolResult.success,
                        error: toolResult.error,
                        ...(autoApprovedBy ? { autoApprovedBy } : {})
                    });

                    // Auto-verification: run diagnostics/lint/typecheck on file-modifying tools
                    let verificationText: string | undefined;
                    if (toolResult.success && ['edit_file', 'write_file', 'apply_patch'].includes(toolCall.name)) {
                        const autoVerifyEnabled = vsconfig.get<boolean>('autoVerifyEnabled') ?? true;
                        const inBuildMode = mode === 'build' || mode === 'debug';

                        if (autoVerifyEnabled && inBuildMode) {
                            const autoVerifyTimeout = vsconfig.get<number>('autoVerifyTimeout') ?? 60;
                            const lintOverride = vsconfig.get<string>('autoVerifyLintCommand');
                            const testOverride = vsconfig.get<string>('autoVerifyTestCommand');
                            const verifyConfig = {
                                enabled: true,
                                timeout: autoVerifyTimeout,
                                steps: {
                                    diagnostics: true,
                                    typecheck: true,
                                    lint: true,
                                    test: false, // Tests are slow — model can call run_tests explicitly
                                },
                                commands: {
                                    ...(lintOverride ? { lint: lintOverride } : {}),
                                    ...(testOverride ? { test: testOverride } : {}),
                                },
                            };

                            try {
                                const parsedArgs = typeof toolCall.arguments === 'string'
                                    ? JSON.parse(toolCall.arguments)
                                    : toolCall.arguments;
                                const verifyResult = await runVerification(
                                    toolCall.name,
                                    parsedArgs as Record<string, unknown>,
                                    toolOutput,
                                    verifyConfig
                                );
                                verificationText = formatVerification(verifyResult);

                                // Append verification to webview
                                this.post({
                                    command: 'verificationResult',
                                    toolId: toolCall.id,
                                    result: verifyResult,
                                    text: verificationText,
                                });
                            } catch (ve) {
                                // Don't fail the turn if verification crashes
                                console.warn('[auto-verify] Failed:', ve);
                            }
                        }
                    }

                    // Give the LLM an actionable error message for common failures
                    // Cap tool output to prevent context explosion (configurable, default 15K chars)
                    const maxToolOutput = vsconfig.get<number>('toolOutputMaxChars') || 15000;
                    let truncatedOutput = String(toolOutput || '');
                    if (truncatedOutput.length > maxToolOutput) {
                        const tail = truncatedOutput.slice(-maxToolOutput);
                        truncatedOutput = `[Output truncated from ${truncatedOutput.length} chars, keeping last ${maxToolOutput}]\n${tail}`;
                    }
                    const contentPayload: Record<string, unknown> = {
                        success: toolResult.success,
                        output: truncatedOutput,
                    };
                    if (verificationText) {
                        contentPayload.verification = verificationText;
                    }
                    if (!toolResult.success && toolResult.error) {
                        const errMsg = String(toolResult.error);
                        // Add guidance for common failures so the LLM can self-recover
                        if (errMsg.includes('PATH_OUTSIDE_WORKSPACE') || errMsg.includes('PATH_TRAVERSAL_DETECTED')) {
                            contentPayload.guidance = `The path "${String(toolCall.arguments).slice(0, 200)}" is outside the workspace or uses invalid path format. Use a workspace-relative path from the project root.`;
                        } else if (errMsg.includes('FILE_ALREADY_EXISTS')) {
                            contentPayload.guidance = 'The file already exists. Retry the write_file call with overwrite=true to replace it.';
                        }
                        contentPayload.error = errMsg.slice(0, 5000);
                    }
                    const toolMsg: ChatCompletionMessage = {
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(contentPayload)
                    };
                    this.apiMessages.push(toolMsg);
                    this._addToTranscript(toolMsg);

                    // Per-tool failure tracking
                    if (toolResult.success) {
                        toolFailureCounts.delete(toolCall.name);
                        anySuccess = true;
                    } else {
                        toolFailureCounts.set(toolCall.name, (toolFailureCounts.get(toolCall.name) || 0) + 1);
                    }
                }

                // Update global counters for turn limit logic
                const worstFailureTool = [...toolFailureCounts.entries()]
                    .sort((a, b) => b[1] - a[1])[0];
                if (worstFailureTool) {
                    lastFailureTool = worstFailureTool[0];
                    consecutiveFailures = worstFailureTool[1];
                } else if (anySuccess) {
                    consecutiveFailures = 0;
                    lastFailureTool = '';
                }

                // Auto-extend turns when making progress (successes), hard-stop on stuck loops
                if (anySuccess && !lastFailureTool) {
                    maxTurns = Math.max(maxTurns, maxTurnsBase + toolTurnCount * 2);
                }
                // Hard stop: same tool failed 2+ times = stuck loop
                if (consecutiveFailures >= 2 && lastFailureTool) {
                    finalResponse = `I'm having trouble with the **${lastFailureTool}** tool — it keeps failing. I've tried ${consecutiveFailures} time(s). Please help by clarifying the path or what you'd like me to do instead.`;
                    hasStreamedContent = false;
                    break;
                }
                // Hard stop: absolute ceiling
                if (turn >= maxTurnsHard - 1) {
                    finalResponse = this.stripToolMarkup(result.content);
                    if (!finalResponse) {
                        finalResponse = `Reached maximum tool turns (${maxTurnsHard}). The assistant performed ${toolTurnCount} tool invocation(s) but did not complete.`;
                    } else {
                        finalResponse += `\n\n⚠️ Reached maximum tool turns (${maxTurnsHard}) — response may be incomplete.`;
                    }
                    hasStreamedContent = false;
                }

                if (turn === maxTurns - 1 && !finalResponse) {
                    finalResponse = this.stripToolMarkup(result.content);
                    if (!finalResponse) {
                        finalResponse = `Reached maximum tool turns (${maxTurns}). The assistant performed ${toolTurnCount} tool invocation(s) but did not complete.`;
                    } else {
                        finalResponse += `\n\n⚠️ Reached maximum tool turns (${maxTurns}) — response may be incomplete.`;
                    }
                    // Force non-streamed so it gets posted below
                    hasStreamedContent = false;
                }

                if (this.getAbortController()?.signal.aborted) {
                    throw new DOMException('Aborted by user', 'AbortError');
                }

                // --- Mid-loop token budget enforcement (with C3 reservation + C5 thrash) ---
                // Tool results can blow up context between turns. Check and compress here.
                this._syncContext();

                const midTokenCount = this.contextManager.getContextSize();
                const midEffectiveUsage = midTokenCount + RESERVE_FOR_TOOL_TURN;

                // Thrash-protected summarization: if effective usage exceeds threshold,
                // try to compact — but stop if it's not helping.
                if (midEffectiveUsage > windowSize * 0.75) {
                    if (!this._thrashing) {
                        const batchBudget = this.contextManager.getMaxSummaryBatchTokens();
                        const toSummarize = this.contextManager.getMessagesToSummarize(batchBudget);
                        if (toSummarize.length > 0) {
                            await this._summarizeConversation(apiClient, toSummarize);
                            this._trackCompaction(this.contextManager.getContextSize());
                        }
                    }

                    if (this._thrashing) {
                        // Thrash detected — emergency drop without API call
                        const dropped = this.contextManager.emergencyDrop(windowSize * 0.5);
                        if (dropped > 0) {
                            this._pullContext(); // See _pullContext()'s doc comment.
                            this.post({
                                command: 'status',
                                text: `⚠️ Context keeps filling up after compaction. Dropped ${dropped} messages. A tool output may be too large.`,
                            });
                        }
                    }
                }

                // Aggressive trim if we're dangerously close to the limit
                if (this.contextManager.needsHardTrim()) {
                    this._trimContext(windowSize * 0.7);
                }

                // Final safety net: hard trim before next API call
                const postTrimTokens = this.contextManager.getContextSize();
                if (postTrimTokens + RESERVE_FOR_TOOL_TURN > windowSize * 0.85) {
                    this._trimContext(windowSize * 0.75);
                }

                // If context is STILL over the hard limit, try emergency drop
                if (this.contextManager.getContextSize() + RESERVE_FOR_TOOL_TURN > windowSize * 0.9) {
                    const dropped = this.contextManager.emergencyDrop(windowSize * 0.75);
                    if (dropped > 0) {
                        this._pullContext(); // See _pullContext()'s doc comment.
                        this.post({
                            command: 'status',
                            text: `Dropped ${dropped} old messages to prevent context overflow`
                        });
                    }
                }

                // Absolute last resort: abort with helpful message
                if (this.contextManager.getContextSize() + RESERVE_FOR_TOOL_TURN > windowSize * 0.95) {
                    finalResponse = `⚠️ **Context window exhausted** — the conversation has grown too large (${Math.round(this.contextManager.getContextSize() / 1000)}K/${Math.round(windowSize / 1000)}K tokens). Use /compact or start a new chat to continue.`;
                    hasStreamedContent = false;
                    break;
                }

                // Periodic save after each tool turn so a reload doesn't lose progress.
                // Awaited (P5-T6) — a crash between tool turns is exactly the gap this
                // save exists to close; firing it without waiting defeats the purpose.
                if (this._originalChatId) {
                    await this._saveChat(this._originalChatId);
                }

                const midTokenUsage = this.contextManager.getContextSize();
                this.post({
                    command: 'tokenCount',
                    used: midTokenUsage,
                    limit: windowSize,
                    msgCount: this.apiMessages.filter(m => m.role !== 'system').length,
                    summaryCount: this.contextManager.getSummaries().length,
                });
            }

            // Post final response
            if (finalResponse) {
                if (!hasStreamedContent) {
                    // Non-streaming or tool-only path: show the full response
                    this.post({
                        command: 'receiveMessage',
                        text: finalResponse,
                        mode,
                        durationMs: Date.now() - segmentStartTime,
                        tokens: ContextManager.countTokens(finalResponse),
                    });
                }
                // When hasStreamedContent && toolTurnCount > 0, the final response
                // was already streamed chunk-by-chunk in the last turn — no need to duplicate.
            }

            const postTokenCount = this.contextManager.getContextSize();
            this.post({
                command: 'tokenCount',
                used: postTokenCount,
                limit: windowSize,
                msgCount: this.apiMessages.filter(m => m.role !== 'system').length,
                summaryCount: this.contextManager.getSummaries().length,
            });

            // Persist before signaling the turn as done (P5-T6) — otherwise the UI
            // can show "finished" while the newest messages still only exist in
            // memory, and a crash/reload right after would silently lose them.
            const postChatId = this._originalChatId;
            if (postChatId) {
                await this._saveChat(postChatId);
            }

            // Carries this final segment's own duration/tokens (not the whole
            // multi-turn exchange) for the caption under this text bubble —
            // harmless when this streamEnd is actually the tool-only "no text
            // at all" case, since the webview only renders a caption when
            // it's finalizing a real streamed message row.
            this.post({
                command: 'streamEnd',
                durationMs: Date.now() - segmentStartTime,
                tokens: ContextManager.countTokens(finalResponse),
            });
        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                // Do NOT save on abort — _createNewChat / _switchChat already
                // captured a snapshot of apiMessages and saved it BEFORE calling
                // abort(). Saving here would overwrite that snapshot with whatever
                // is currently in apiMessages (often an empty array after the
                // caller cleared it), wiping the original chat's history.
                this.post({
                    command: 'receiveMessage',
                    text: '⏹ Generation stopped by user.',
                    mode: this.modeManager.getCurrentMode()
                });
                return;
            }

            // Save current state on non-abort errors so a reload doesn't lose context.
            if (this._originalChatId) {
                await this._saveChat(this._originalChatId);
            }

            const errorMessage = (error as Error).message || 'Unknown error';

            // Detect unrecoverable errors — these should NOT trigger a retry and
            // should NOT strip the user message, because the conversation history
            // is valid and the user may need to continue after fixing the root cause.
            const isUnrecoverable = errorMessage.includes('No user query') ||
                errorMessage.includes('invalid_parameter_value') ||
                errorMessage.includes('malformed');

            // Remove the orphaned user message only for transient/retryable errors.
            // For unrecoverable errors, preserve the full conversation state.
            let failedInput: string | null = null;
            if (!isUnrecoverable) {
                const lastIdx = this.apiMessages.length - 1;
                if (lastIdx >= 0 && this.apiMessages[lastIdx].role === 'user') {
                    failedInput = this.apiMessages[lastIdx].content;
                    this.apiMessages.splice(lastIdx, 1);
                }
            }

            this.post({
                command: 'receiveMessage',
                text: `⚠️ **LLM API error:** ${errorMessage}`,
                mode,
                isError: true
            });

            // Auto-retry once for transient errors — re-send the same user input.
            // Skip retry for unrecoverable errors (e.g., "No user query found").
            // H-3: the main turn loop guards a mid-turn chat switch at two
            // points (this._activeChatChangedSinceTurnStart(), lines ~328,
            // ~440) before writing into apiMessages — this catch-block retry
            // path re-pushed a message and kept streaming/saving with no
            // such guard, so a chat switch during the 1.5s backoff (or the
            // retry call itself) could write the retried response into
            // whichever chat is now active instead of the one that failed.
            if (failedInput && !isUnrecoverable && !this.getAbortController()?.signal.aborted && !this._activeChatChangedSinceTurnStart()) {
                this.post({ command: 'status', text: 'Retrying...' });
                await new Promise(r => setTimeout(r, 1500));

                if (this._activeChatChangedSinceTurnStart()) {
                    return;
                }

                // Re-push and call sendMessage recursively. The recursion is safe
                // because setIsProcessing(true) at the top will pass (isProcessing
                // was reset in finally... but wait, finally hasn't run yet).
                // Instead, just re-do the inner loop manually.
                this.apiMessages.push({ role: 'user', content: failedInput });
                this._syncContext();

                try {
                    // Re-run the streaming call directly (same logic as the for-loop body).
                    const retryResult = await apiClient.sendMessageStreaming(
                        this.apiMessages,
                        mode,
                        config.openCodeEnabled,
                        (chunk: string) => {
                            hasStreamedContent = true;
                            streamedContentBuffer += chunk;
                            this.post({ command: 'streamChunk', text: chunk });
                        },
                        this.getAbortController()?.signal
                    );

                    if (this._activeChatChangedSinceTurnStart()) {
                        return;
                    }

                    if (retryResult.streamInterrupted) {
                        finalResponse = streamedContentBuffer.trim() || 'Stream was interrupted.';
                        this._replacePartialWithFinal(finalResponse);
                        this.apiMessages.push({ role: 'assistant', content: finalResponse });
                    } else if (retryResult.toolCalls.length === 0) {
                        finalResponse = this.stripToolMarkup(retryResult.content) || 'No response from model.';
                        this._replacePartialWithFinal(retryResult.content || finalResponse);
                        this.apiMessages.push({ role: 'assistant', content: retryResult.content || finalResponse });
                    } else {
                        // Retry returned tool calls — execute them once then stop.
                        // This avoids deep recursion into the full tool-call loop.
                        this.post({ command: 'streamEnd' });
                        for (const tc of retryResult.toolCalls) {
                            this.post({ command: 'toolCall', toolId: tc.id, toolName: tc.name, args: JSON.stringify(tc.arguments), status: 'running' });
                        }
                        const retryToolResults = await toolCallHandler.executeToolCallsBatch(retryResult.toolCalls);
                        this._replacePartialWithFinal(retryResult.content || '');
                        const sanitizedCalls: NativeToolCall[] = retryResult.toolCalls.map(tc => ({
                            id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) }
                        }));
                        this.apiMessages.push({ role: 'assistant', content: retryResult.content || '', tool_calls: sanitizedCalls });
                        for (let i = 0; i < retryResult.toolCalls.length; i++) {
                            const tr = retryToolResults[i];
                            this.apiMessages.push({ role: 'tool', tool_call_id: retryResult.toolCalls[i].id, content: JSON.stringify({ success: tr.success, output: tr.output, ...(tr.error ? { error: tr.error } : {}) }) });
                            this.post({ command: 'toolResult', toolId: retryResult.toolCalls[i].id, output: tr.output || tr.error || '', success: tr.success, error: tr.error });
                        }
                        finalResponse = this.stripToolMarkup(retryResult.content) || '';
                        hasStreamedContent = false;
                    }
                } catch (retryErr) {
                    // Retry also failed — clean up and show error.
                    const rLastIdx = this.apiMessages.length - 1;
                    if (rLastIdx >= 0 && this.apiMessages[rLastIdx].role === 'user') {
                        this.apiMessages.splice(rLastIdx, 1);
                    }
                    const retryMsg = (retryErr as Error).message || 'Retry also failed';
                    if ((retryErr as Error).name !== 'AbortError') {
                        this.post({
                            command: 'receiveMessage',
                            text: `⚠️ **Retry also failed:** ${retryMsg}. Please try again.`,
                            mode,
                            isError: true
                        });
                    }
                }

                // After successful retry, post final response and save state
                // (the normal post-loop code in the try block is skipped after catch).
                if (finalResponse && !hasStreamedContent) {
                    this.post({
                        command: 'receiveMessage',
                        text: finalResponse,
                        mode
                    });
                }
                this._syncContext();
                this.post({
                    command: 'tokenCount',
                    used: this.contextManager.getContextSize(),
                    limit: config.contextWindowSize,
                });
                // Persist before streamEnd (P5-T6) — same reasoning as the main
                // end-of-turn save path.
                if (this._originalChatId) {
                    await this._saveChat(this._originalChatId);
                }
                this.post({ command: 'streamEnd' });
            }
        } finally {
            this._originalChatId = null;
            this.setIsProcessing(false);
            this.setAbortController(null);
            // L-1: skip the redundant re-post if stop() already sent these
            // for this turn.
            if (!this._stoppedByUser) {
                this.post({ command: 'processingState', processing: false });
                this.post({ command: 'hideStopBtn' });
            }
            this._stoppedByUser = false;
            this.post({ command: 'status', text: '' });
        }
    }

    /**
     * Drop any RAG-retrieved-context block baked into the current system
     * message (compact()'s Phase 0 — see that call site for why). Returns
     * the number of tokens freed, purely for status reporting; 0 if there
     * was nothing to drop.
     */
    private _dropRetrievedContext(): number {
        if (this.contextManager.getRetrievedChunks().length === 0) return 0;

        const marker = "Here are relevant files from the codebase to help answer the user's question:";
        const sysIdx = this.apiMessages.findIndex(m => m.role === 'system');
        let freedTokens = 0;

        if (sysIdx >= 0) {
            const sysMsg = this.apiMessages[sysIdx];
            const idx = sysMsg.content ? sysMsg.content.indexOf(marker) : -1;
            if (idx >= 0) {
                const trimmedContent = sysMsg.content!.slice(0, idx).replace(/\n+$/, '');
                freedTokens = ContextManager.countTokens(sysMsg.content!.slice(idx));
                this.apiMessages[sysIdx] = { ...sysMsg, content: trimmedContent };
            }
        }

        this.contextManager.clearRetrievedContext();
        this._syncContext();
        return freedTokens;
    }

    /** Truncate oversized tool result content in-place (keep last 3.5K chars of output).
     * Free operation — no API call needed. Idempotent across rounds. */
    private _truncateOversizedToolResults(): void {
        for (let i = 0; i < this.apiMessages.length; i++) {
            const msg = this.apiMessages[i];
            if (msg.role === 'tool' && msg.content && msg.content.length > 5000) {
                let truncatedContent: string | undefined;
                try {
                    const parsed: Record<string, unknown> = JSON.parse(msg.content);
                    if (parsed.output && typeof parsed.output === 'string' && parsed.output.length > 4000) {
                        const tail = parsed.output.slice(-3500);
                        parsed.output = `[Output truncated from ${parsed.output.length} chars, keeping last 3500]\n${tail}`;
                        truncatedContent = JSON.stringify(parsed);
                    }
                } catch {
                    // Not JSON — truncate directly
                    truncatedContent = `[Truncated from ${msg.content.length} chars]\n${msg.content.slice(-4000)}`;
                }

                if (truncatedContent === undefined) continue;
                this.apiMessages[i] = { ...msg, content: truncatedContent };

                // M-3: mirror the truncation into the matching transcript
                // entry (correlated by tool_call_id) — previously only
                // apiMessages was truncated, so the transcript (and anything
                // saved/restored/displayed from it) kept the full,
                // untruncated content forever, diverging from what the
                // model actually saw.
                if (msg.tool_call_id) {
                    const tIdx = this._transcript.findIndex(t => t.role === 'tool' && t.tool_call_id === msg.tool_call_id);
                    if (tIdx >= 0) {
                        this._transcript[tIdx] = { ...this._transcript[tIdx], content: truncatedContent };
                    }
                }
            }
        }
    }

    /** Trim oldest user/assistant pairs until context fits under target tokens.
     * Strategy: first truncate oversized tool results, then remove oldest messages.
     * Returns the number of messages dropped so the caller can notify the user. */
    private _trimContext(targetTokens: number): number {
        let dropped = 0;

        // Phase 1: Truncate oversized tool result content
        this._truncateOversizedToolResults();
        this._syncContext();

        // Check if we're already under target after truncation
        let runningTokens = this.contextManager.getContextSize();
        if (runningTokens <= targetTokens) return 0;

        // Phase 2: Remove oldest non-system messages one by one.
        // H-1: getContextSize() reads contextManager's own copy of the
        // messages array (set via _syncContext()), not this.apiMessages
        // directly — the loop's exit condition is now driven by the local
        // runningTokens total (updated below) rather than re-querying
        // contextManager, so there's no stale-snapshot risk to begin with.
        //
        // P-2: previously called contextManager.getContextSize() — a full
        // re-tokenize of every remaining message via real tiktoken encoding
        // — AND _syncContext() — a full array copy — on every single
        // iteration of this loop. Dropping k of n messages cost O(n × k)
        // tiktoken-encode work, quadratic for a trim that removes a large
        // fraction of the conversation. Each removed message's own token
        // cost is now computed once (ContextManager.countMessageTokens) and
        // subtracted from a running total instead; _syncContext() runs once
        // after the loop rather than once per removal.
        while (this.apiMessages.length > 1 && runningTokens > targetTokens) {
            const idx = this.apiMessages.findIndex(m => m.role !== 'system');
            if (idx < 0) break;
            const [removed] = this.apiMessages.splice(idx, 1);
            runningTokens -= ContextManager.countMessageTokens(removed);
            dropped++;
        }

        // Notify user about context trimming
        if (dropped > 0) {
            this._syncContext();
            this.post({
                command: 'contextTrimmed',
                droppedCount: dropped,
                remainingTokens: runningTokens,
            });
        }

        return dropped;
    }

    /** Summarize old conversation history to free up context space.
     * Captures recently-touched file paths for retention (Qwen Code-style).
     * @param apiClient  The API client to use for summarization.
     * @param preComputed  Optional pre-computed message list (with token budget).
     *                      When provided, avoids re-fetching and respects the caller's budget. */
    private async _summarizeConversation(apiClient: ApiClient, preComputed?: ChatCompletionMessage[]): Promise<void> {
        // Capture recently touched files BEFORE removing old messages
        const recentFiles = this.contextManager.getRecentlyTouchedFiles(5);

        const toSummarize = preComputed ?? this.contextManager.getMessagesToSummarize();
        if (toSummarize.length === 0) return;

        this.post({
            command: 'status',
            text: `Summarizing ${toSummarize.length} earlier messages...`
        });

        try {
            const summary = await apiClient.summarizeConversation(toSummarize, this.getAbortController()?.signal);
            if (!summary) {
                console.warn('Summarization returned empty result');
                this.post({
                    command: 'status',
                    text: '⚠️ Summarization returned empty — context not compressed',
                });
                return;
            }

            const block = this.contextManager.injectSummary(summary, recentFiles, toSummarize);

            this.post({
                command: 'summaryInjected',
                compressedCount: block.compressedCount,
                summaryTokenCount: block.tokenCount,
            });

            // Show context management notification to user
            this.post({
                command: 'status',
                text: `📋 Summarized ${block.compressedCount} messages into ${block.tokenCount} tokens`,
            });

            // See _pullContext()'s doc comment — this was _syncContext()
            // (wrong direction), the same bug as compact()'s. This is the
            // most-called summarization path in the class (auto-triggered
            // from three separate places in sendMessage()'s flow), so this
            // was very likely the single biggest source of "compaction
            // reported progress but the API request/saved chat didn't
            // shrink" in normal usage, not just manual /compact.
            this._pullContext();
        } catch (err) {
            // Summarization failed — no messages were removed (injectSummary is called
            // after the API succeeds), so conversation state is intact. Fall through
            // to hard-trim as backup.
            console.warn('Summarization failed:', err);
            this.post({
                command: 'status',
                text: '⚠️ Summarization failed — falling back to message trimming',
            });
        }
    }

    public stripToolMarkup(content: string): string {
        return content
            .replace(/\u200b\u001d.*?\u001c\u200b/g, '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
            .replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
            .trim();
    }

    /** Manually compact conversation history (user-triggered via /compact).
     * Works even when context is nearly full by summarizing in chunks. */
    public async compact(): Promise<void> {
        const apiClient = this.getApiClient();
        if (!apiClient) {
            this.post({ command: 'status', text: 'Compact failed — no API client' });
            return;
        }

        // M-1: capture the chat id up front, like sendMessage's
        // _originalChatId — compact() can run multiple summarization API
        // calls (real network round-trips), and if the user switches chats
        // mid-compact, getActiveChatId() at save time would return the NEW
        // chat's id, silently saving this (old) chat's compacted content
        // into the new chat.
        const compactChatId = this.getActiveChatId();

        const windowSize = ApiClient.getConfig().contextWindowSize;
        const beforeTokens = this.contextManager.getContextSize();

        // Chat-switch bug: compact() has no abort wiring at all, unlike
        // sendMessage() — switching chats mid-compact previously did nothing
        // to it, and none of its post() calls carried a chatId, so every
        // update (including the final compactDone banner) kept landing in
        // whatever chat the webview happened to be showing by the time each
        // message arrived, not the chat actually being compacted. Every post
        // below now carries chatId: compactChatId, and the webview filters by
        // it exactly the way it already does for agentSpawn/agentProgress
        // (see main.js's activeChatId checks) — same established pattern,
        // just never extended to compact's own messages.
        const postForThisCompact = (msg: Record<string, unknown>): void => {
            this.post({ ...msg, chatId: compactChatId });
        };

        // Stop-button wiring: compact() previously had no cancellation path
        // at all, so clicking Stop while a compact was running did nothing.
        // stop() (above) aborts this controller; checked at every checkpoint
        // below alongside the chat-switch check, since both mean "stop
        // touching shared state now."
        const abortController = new AbortController();
        this._compactAbortController = abortController;
        const shouldStopCompact = (): boolean =>
            this.getActiveChatId() !== compactChatId || abortController.signal.aborted;

        let totalCompressed = 0;
        let totalDropped = 0;
        let round = 0;
        const maxRounds = 10; // Safety limit to prevent infinite loops

        // Pick a target that makes sense regardless of window size.
        // For small windows (< 32K) use 50% of window.
        // For large windows cap at 24K so /compact actually works at 28K etc.
        const targetTokens = Math.min(Math.floor(windowSize * 0.5), 24000);

        // Show a compacted indicator in the message area so the user sees it.
        // Carries targetTokens/maxRounds so the webview can render real
        // progress (round X/maxRounds, tokens toward target) instead of an
        // opaque "batch N" counter with nothing to compare it against.
        postForThisCompact({ command: 'compactStart', beforeTokens, targetTokens, maxRounds });
        this.setIsProcessing(true);
        this.post({ command: 'processingState', processing: true });
        this.post({ command: 'showStopBtn' });

        // Phase 0: drop any RAG-retrieved-context block baked into the current
        // system message. Free (no API call) and safe to do unconditionally in
        // compact() specifically — retrieved context is rebuilt fresh on the
        // next turn if still relevant, and compact() (unlike _trimContext's
        // mid-turn auto-trim) isn't run while a request is answering the
        // question that context was retrieved for. This closes a real gap:
        // getAvailableRetrievalTokens() budgets retrieval as "whatever room is
        // left in the window," so a single turn's retrieval can inject nearly
        // the entire window's worth of tokens into a role:'system' message —
        // and both getMessagesToSummarize() and emergencyDrop() below
        // explicitly skip system-role messages. Without this, a short
        // conversation whose bulk is one large retrieval injection could
        // report "compacted 137K -> 137K" with zero actual reduction, because
        // neither compaction path could ever touch the one thing dominating
        // the token count.
        const retrievedTokensDropped = this._dropRetrievedContext();

        // One-time truncation of oversized tool results (free, no API call).
        // Do this once upfront rather than every round to avoid repeated aggressive trimming.
        this._truncateOversizedToolResults();

        while (round < maxRounds) {
            round++;

            // Bail out completely the moment the active chat changes, or the
            // user hits Stop — switching chats (chatManager.switchChat())
            // calls contextManager.clearContext() + setApiMessages() on this
            // SAME shared ContextManager instance, out from under this loop.
            // Every this.contextManager.*/this.apiMessages access below this
            // point would silently start operating on the NEWLY active
            // chat's live data instead of compactChatId's — meaning a chat
            // switch here wasn't just a stray UI update in the wrong chat, it
            // could actually summarize/drop the OTHER (currently active)
            // chat's real messages while this function still thinks it's
            // compacting the original one. Nothing has been saved to disk
            // yet at this point (the only save is after the loop), so
            // bailing here loses only this attempt's in-memory work — the
            // original chat is left exactly as it was on disk, safe to
            // /compact again later.
            if (this.getActiveChatId() !== compactChatId) {
                // Don't post into a chat we're no longer viewing — the
                // frontend's activeChatChanged handler already resets the
                // progress bar and stop button for us.
                this._compactAbortController = null;
                return;
            }
            if (abortController.signal.aborted) {
                // Same chat, explicit Stop click — this one DOES need an
                // explicit message, since nothing else will clear the
                // progress bar/stop button for a chat that never changed.
                postForThisCompact({ command: 'compactStopped' });
                this.setIsProcessing(false);
                this.post({ command: 'processingState', processing: false });
                this.post({ command: 'hideStopBtn' });
                this._compactAbortController = null;
                return;
            }

            const currentTokens = this.contextManager.getContextSize();

            // Stop once we hit the absolute target OR there's nothing left to compress
            if (currentTokens <= targetTokens) break;

            // Phase 1: Try chunked summarization (preferred — preserves conversation structure)
            const batchBudget = this.contextManager.getMaxSummaryBatchTokens();
            const toSummarize = this.contextManager.getMessagesToSummarize(batchBudget);

            if (toSummarize.length > 0) {
                // Structured progress (round/target/current tokens), not just
                // an opaque "batch N" string with nothing to compare it
                // against — the webview renders this as a live progress bar.
                postForThisCompact({
                    command: 'compactProgress',
                    round,
                    maxRounds,
                    beforeTokens,
                    currentTokens,
                    targetTokens,
                    detail: `batch ${round}, ${toSummarize.length} messages`,
                });
                postForThisCompact({
                    command: 'status',
                    text: `Compacting... (batch ${round}, ${toSummarize.length} messages)`
                });

                try {
                    const summary = await apiClient.summarizeConversation(toSummarize, abortController.signal);
                    // Same bail-out as the top of the loop, but after a real
                    // network round-trip — the longest async gap in this
                    // function, and the one most likely to overlap a chat
                    // switch. `summary` (and `toSummarize`'s message objects)
                    // belong to compactChatId; injecting them into whatever
                    // chat is active now would corrupt it.
                    if (this.getActiveChatId() !== compactChatId) {
                        return;
                    }
                    if (summary) {
                        const recentFiles = this.contextManager.getRecentlyTouchedFiles(5);
                        const block = this.contextManager.injectSummary(summary, recentFiles, toSummarize);
                        totalCompressed += block.compressedCount;
                        // See _pullContext()'s doc comment — injectSummary()
                        // mutates contextManager's own array, not
                        // this.apiMessages; _syncContext() here (as this used
                        // to call) would push the wrong direction and erase
                        // the reduction just computed.
                        this._pullContext();
                        continue; // Re-check token count after injection
                    }
                } catch (err) {
                    console.warn('Summarization failed:', err);
                }
            }

            // Phase 2: Emergency — drop oldest messages only when summarization can't help.
            // Target: just get under the compact target, not aggressively trim further.
            const dropped = this.contextManager.emergencyDrop(targetTokens);
            if (dropped > 0) {
                totalDropped += dropped;
                this._pullContext(); // Same reasoning as injectSummary() above.
                postForThisCompact({
                    command: 'compactProgress',
                    round,
                    maxRounds,
                    beforeTokens,
                    currentTokens: this.contextManager.getContextSize(),
                    targetTokens,
                    detail: `dropped ${dropped} old messages`,
                });
                postForThisCompact({
                    command: 'status',
                    text: `Dropped ${dropped} old messages to free space`
                });
                continue;
            }

            // Nothing more we can do
            break;
        }

        const afterTokens = this.contextManager.getContextSize();

        // Distinguishes "ran and genuinely made no progress" (which looks
        // like a bug) from "was already under the compact target, so there
        // was nothing to summarize or drop" (correct, expected no-op) — both
        // previously rendered as the exact same "Compacted — NK -> NK
        // tokens" text, which is indistinguishable from a failure. See the
        // loop's first check: `if (currentTokens <= targetTokens) break`
        // exits on round 1 without touching anything whenever the chat is
        // already small enough — for any window >= 48K that means anything
        // already under 24K tokens.
        const alreadyUnderTarget = totalCompressed === 0 && totalDropped === 0 &&
            retrievedTokensDropped === 0 && beforeTokens <= targetTokens;

        // Save after compact — compacted messages + full transcript for display.
        // Uses the chat id captured at the start of compact() (M-1), not
        // whatever chat happens to be active now.
        if (compactChatId) {
            await this._saveChat(compactChatId);
        }

        // Notify the webview that compaction is done.
        // Do NOT re-render messages — the visible chat area already shows the full
        // transcript. Re-rendering from apiMessages would wipe out summarized turns
        // that the user still wants to see (matches auto-compact behavior).
        postForThisCompact({
            command: 'compactDone',
            beforeTokens,
            afterTokens,
            totalCompressed,
            totalDropped,
            retrievedTokensDropped,
            targetTokens,
            alreadyUnderTarget,
        });

        // Update context ring with new token count. Only meaningful for the
        // chat that was actually compacted — if the active chat changed
        // (postForThisCompact already suppresses the frontend from showing
        // it), skip posting a token count entirely rather than let it flow
        // through and silently overwrite the NEW chat's context ring with
        // stale numbers from this one.
        if (this.getActiveChatId() === compactChatId) {
            const config = ApiClient.getConfig();
            this.post({
                command: 'tokenCount',
                used: afterTokens,
                limit: config.contextWindowSize,
                msgCount: this.apiMessages.filter(m => m.role !== 'system').length,
                summaryCount: this.contextManager.getSummaries().length
            });
            // Reset the stop button shown at the start of this function.
            // The chat-switch/abort bail-out paths above handle their own
            // cases; this covers the normal (non-interrupted) completion.
            this.setIsProcessing(false);
            this.post({ command: 'processingState', processing: false });
            this.post({ command: 'hideStopBtn' });
        }
        this._compactAbortController = null;
    }

    /** Regenerate the last AI response by re-sending the last user message. */
    public regenerate(): void {
        let lastUserIndex = -1;
        for (let i = this.apiMessages.length - 1; i >= 0; i--) {
            if (this.apiMessages[i].role === 'user') {
                lastUserIndex = i;
                break;
            }
        }
        if (lastUserIndex < 0) return;

        const lastUserMsg = this.apiMessages[lastUserIndex].content;
        this.apiMessages.splice(lastUserIndex + 1);

        const mode = this.modeManager.getCurrentMode();
        this.sendMessage(String(lastUserMsg), mode);
    }

    /** Stop current generation. */
    /** L-1: set here and checked in sendMessage()'s finally block so a
     * user-initiated stop doesn't post processingState/hideStopBtn twice —
     * once from here, once from finally when the abort unwinds the still-running
     * turn. streamEnd isn't duplicated (only stop() posts it), so it's left as-is. */
    private _stoppedByUser = false;

    /**
     * Aborts a running compact() call, if any. compact() has no relation to
     * the sendMessage()-specific abortController above — it's a separate
     * long-running operation (multiple real summarization API calls) that
     * previously had no cancellation path at all, so the Stop button simply
     * did nothing while a compact was in progress.
     */
    private _compactAbortController: AbortController | null = null;

    public stop(): void {
        const controller = this.getAbortController();
        if (controller) {
            controller.abort();
            this.setAbortController(null);
        }
        this._compactAbortController?.abort();
        this._stoppedByUser = true;
        this.setIsProcessing(false);
        this.post({ command: 'processingState', processing: false });
        this.post({ command: 'hideStopBtn', wasStopped: true });
        this.post({ command: 'streamEnd', interrupted: true });
    }

    /** Stop a running sub-agent by ID. */
    public stopAgent(agentId: string): boolean {
        return getAgentManager().stopAgent(agentId);
    }

    /**
     * Reset the conversation: clear all messages, context, and streaming state.
     * Keeps the system prompt so the next message starts fresh.
     */
    public resetConversation(): void {
        // Abort any in-flight request
        const controller = this.getAbortController();
        if (controller) {
            controller.abort();
            this.setAbortController(null);
        }
        this.setIsProcessing(false);

        // P5-T5: tear down any sub-agents that belonged to this chat so they
        // don't keep running (or lingering in the registry) after a reset.
        const chatId = this.getActiveChatId();
        if (chatId) {
            getAgentManager().clearChatAgents(chatId);
        }

        // Clear messages but keep system prompt position
        this.apiMessages.length = 0;
        this.contextManager.clearContext();

        // M-16: _transcript is a separate append-only history array (kept
        // for pre-compaction display) — clearing apiMessages alone left old
        // history persisting in transcript snapshots/saves after an explicit
        // reset.
        this._transcript.length = 0;

        // Clear partial assistant buffer
        this._partialAssistantContent = null;

        // Notify webview
        this.post({ command: 'clearMessages' });
        this.post({ command: 'processingState', processing: false });
        this.post({ command: 'hideStopBtn' });
        this.post({ command: 'status', text: '' });

        // Re-send initial state so UI resets properly
        const config = ApiClient.mergeConfig(ApiClient.getConfig(), this.getModelConfig());
        this.post({
            command: 'tokenCount',
            used: 0,
            limit: config.contextWindowSize,
        });
    }

    /** Check if the conversation appears stuck (orphaned tool calls or excessive failures). */
    public isStuck(): boolean {
        // If we're not processing but have an active abort controller, something went wrong
        if (!this.isProcessingGetter() && this.getAbortController()) {
            return true;
        }
        // If the last few messages are all tool errors, the loop is likely stuck
        const recentErrors: number[] = [];
        for (let i = this.apiMessages.length - 1; i >= Math.max(0, this.apiMessages.length - 10); i--) {
            const msg = this.apiMessages[i];
            if (msg.role === 'tool') {
                try {
                    const parsed = JSON.parse(msg.content);
                    if (!parsed.success) {
                        recentErrors.push(i);
                        continue;
                    }
                } catch {
                    // L-2: the comment here always said "treat unparseable as
                    // error," but the catch body was empty, so it fell
                    // through to the `break` below instead of counting it —
                    // malformed tool JSON silently exited the stuck-loop scan
                    // uncounted rather than counting as an error like the
                    // comment (and the intent) describes.
                    recentErrors.push(i);
                    continue;
                }
            }
            break;
        }
        // 5+ consecutive tool errors at the tail = stuck
        return recentErrors.length >= 5;
    }

    private _syncContext(): void {
        this.contextManager.setApiMessages([...this.apiMessages]);
    }

    /**
     * Pull contextManager's current apiMessages back into this.apiMessages —
     * the reverse direction of _syncContext(). Required after any call that
     * mutates contextManager's own array in place (injectSummary(),
     * emergencyDrop()) — those methods splice/replace entries on
     * contextManager's private apiMessages field, a DIFFERENT array object
     * from this.apiMessages. Calling _syncContext() afterward (as every call
     * site here used to) pushes this.apiMessages — untouched by the
     * mutation — back INTO contextManager, silently discarding the
     * reduction. Since this.apiMessages is what actually gets sent to the
     * API (sendMessageStreaming(this.apiMessages, ...)) and saved to disk
     * (getMessagesForSave() returns [...this.apiMessages]), that meant every
     * automatic emergency-drop/summarize call in this class — not just
     * manual /compact — could report a reduction that never reached the
     * request payload or the saved chat.
     */
    private _pullContext(): void {
        // apiMessages is a readonly constructor-injected array — other
        // holders of this same array object (e.g. ChatViewProvider) expect
        // it to stay the same reference for the object's whole lifetime, so
        // this mutates in place (same pattern as resetConversation()'s
        // `apiMessages.length = 0`) rather than reassigning.
        const updated = this.contextManager.getApiMessages();
        this.apiMessages.length = 0;
        this.apiMessages.push(...updated);
    }

    /**
     * Append a message to the append-only transcript (C1).
     * The transcript preserves full conversation history across compactions.
     */
    private _addToTranscript(msg: ChatCompletionMessage): void {
        this._transcript.push(msg);
    }

    /**
     * Initialize the transcript from the current apiMessages.
     * Called when restoring a chat from storage.
     */
    public initTranscript(): void {
        this._transcript = [...this.apiMessages];
    }

    /**
     * Initialize the transcript from stored full history.
     * Called when restoring a chat that has a separate transcript in storage.
     */
    public initTranscriptFromMessages(messages: ChatCompletionMessage[]): void {
        this._transcript = [...messages];
    }

    /**
     * Get the full conversation history including pre-compaction messages.
     * Returns the transcript if available, otherwise falls back to active context.
     */
    public getContextSnapshot(): ChatCompletionMessage[] {
        return this._transcript.length > 0 ? [...this._transcript] : [...this.apiMessages];
    }

    /**
     * Get the compacted API messages to persist to storage.
     * Returns apiMessages (which may include summary blocks from compaction).
     * This ensures reload loads the compacted context, not the full transcript.
     */
    public getMessagesForSave(): ChatCompletionMessage[] {
        return [...this.apiMessages];
    }

    /**
     * Get the full transcript for display purposes.
     * Returns the append-only transcript if available, otherwise falls back to apiMessages.
     */
    public getTranscriptForSave(): ChatCompletionMessage[] {
        return this._transcript.length > 0 ? [...this._transcript] : [...this.apiMessages];
    }

    /**
     * Save the current chat state — compacted messages for API context + full transcript for display.
     *
     * Callers on the critical path (end of turn, between tool turns) should
     * `await` this so a crash/reload in the gap between "turn finished" and
     * "turn persisted" can't silently lose the newest messages (P5-T6). A save
     * failure is still swallowed here (logged, not thrown) so it can't break
     * the conversation flow — only its *timing* relative to the caller changed,
     * not its failure behavior.
     */
    private async _saveChat(chatId: string, title?: string): Promise<void> {
        // Snapshot now — the actual write may be queued behind an earlier
        // save (see _enqueueSave/M-2) and apiMessages/_transcript could
        // change again before this write actually runs.
        const messages = this.getMessagesForSave();
        const transcript = this.getTranscriptForSave();
        await this._enqueueSave(() => this.chatStore.saveMessages(chatId, messages, title, transcript));
    }

    /**
     * All chat saves (partial mid-stream saves + final end-of-turn saves)
     * are chained through this single promise queue (M-2). Previously the
     * partial save fired-and-forgot independently of the awaited final
     * save — if the partial save's underlying I/O happened to resolve
     * AFTER a later-issued final save's I/O, it could silently overwrite
     * the complete final state with stale partial content. Chaining
     * through one queue guarantees writes land in the order they were
     * logically issued from this class, regardless of individual I/O
     * timing. Never rejects — a failed save is caught and logged so it
     * can't block subsequent queued saves.
     */
    private _saveQueue: Promise<void> = Promise.resolve();

    private _enqueueSave(op: () => Promise<void>): Promise<void> {
        const next = this._saveQueue.then(op).catch(e => console.warn('[ConversationManager] save failed:', e));
        this._saveQueue = next;
        return next;
    }

    /**
     * Track compaction results for thrash detection (C5).
     * After each auto-compaction, record the resulting token count.
     * If compaction didn't reduce tokens by >20% after MAX_AUTO_COMPACTIONS attempts,
     * declare thrashing and switch to emergency drop mode.
     */
    private _trackCompaction(currentTokens: number): void {
        this._compactCount++;

        if (this._compactCount >= MAX_AUTO_COMPACTIONS) {
            // Check if token count dropped meaningfully (>20% reduction from last compact)
            const reduction = this._lastCompactTokenCount > 0
                ? (this._lastCompactTokenCount - currentTokens) / this._lastCompactTokenCount
                : 0;

            if (reduction < 0.2) {
                this._thrashing = true;
                this.post({
                    command: 'status',
                    text: '⚠️ Context keeps filling up after compaction. A tool output or file read is too large. Consider breaking your task into smaller steps.',
                });
            }
        }

        this._lastCompactTokenCount = currentTokens;
    }

    /**
     * Save partial assistant message so a mid-stream reload doesn't lose in-progress output.
     * Kept separate from apiMessages so the LLM doesn't see incomplete output.
     */
    private _partialAssistantContent: string | null = null;

    private _savePartialAssistantMessage(content: string): void {
        this._partialAssistantContent = content;
        // Use the original chat ID from the active turn so partial saves
        // go to the right chat even if the user switched away mid-stream.
        const saveId = this._originalChatId ?? this.getActiveChatId();
        if (!saveId) return;

        // Build messages array with partial appended for persistence only.
        // Mark with _partial so restore knows it was interrupted mid-stream.
        const persistMessages = [...this.apiMessages, { role: 'assistant' as const, content, _partial: true }];
        // Also build transcript with partial appended
        const persistTranscript = this._transcript.length > 0
            ? [...this._transcript, { role: 'assistant' as const, content, _partial: true }]
            : [...persistMessages];
        // M-2: queued through the same save chain as _saveChat — see
        // _enqueueSave.
        void this._enqueueSave(() => this.chatStore.saveMessages(saveId, persistMessages, undefined, persistTranscript));
    }

    /**
     * Clear the partial buffer — called when the final assistant message is stored.
     */
    private _replacePartialWithFinal(_finalContent: string): void {
        this._partialAssistantContent = null;
    }
}
