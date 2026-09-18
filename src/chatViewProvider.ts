import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ApiClient } from './api/apiClient';
import { ContextManager } from './context/contextManager';
import { ModeManager } from './context/modeManager';
import { ToolCallHandler } from './tools/toolCallHandler';
import { ChatCompletionMessage } from './types';
import { ChatStore, ChatIndexEntry } from './storage/chatStore';
import { RetrievalService } from './indexing/retrievalService';
import { InlineEditProvider } from './edit/inlineEditProvider';
import { ObservabilityService, SessionStats } from './observability/observability';
import { getHtmlForWebview } from './webview/htmlTemplate';
import { ModelManager, ActiveModelConfig } from './provider/modelManager';
import { ChatManager } from './webview/chatManager';
import { ConversationManager } from './conversation/conversationManager';
import { MessageRouter } from './webview/messageRouter';

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private _webviewView?: vscode.WebviewView;
    private contextManager: ContextManager;
    private modeManager: ModeManager;
    private apiClient: ApiClient;
    private toolCallHandler: ToolCallHandler;
    private chatStore: ChatStore;
    private modelManager: ModelManager;
    private chatManager: ChatManager;
    private conversationManager: ConversationManager;
    private messageRouter: MessageRouter;
    private retrievalService: RetrievalService | null = null;
    private inlineEditProvider: InlineEditProvider | null = null;
    private observability: ObservabilityService;

    // Current active chat
    private activeChatId: string | null = null;
    private apiMessages: ChatCompletionMessage[] = [];
    private isProcessing = false;
    private abortController: AbortController | null = null;  // for stop/cancel
    private _globalStoragePath: string = '';
    private _workspaceLabel: string = '';
    private _isWebviewInitialized = false;
    private _hasSentInitialState = false;
    private _pendingSyncAfterPing = false;
    private _webviewMessageDisposable: vscode.Disposable | null = null;
    /** M-13: resolveWebviewView() can run more than once per extension
     * session (e.g. the view container becoming visible again after being
     * hidden), and each call previously registered a NEW onDidChangeVisibility
     * listener into extensionContext.subscriptions with no disposal of the
     * prior one — they'd all fire together on every visibility change,
     * multiplying redundant sync work, until the whole extension deactivated. */
    private _visibilityListenerDisposable: vscode.Disposable | null = null;
    /** M-6: showDiff's temp files were only ever cleaned up by a 30s
     * setTimeout — if the extension deactivated/reloaded before that timer
     * fired, the temp file was orphaned in globalStorageUri permanently.
     * Tracked here so dispose() can clean up anything still pending. */
    private _pendingTempDiffFiles = new Set<string>();

    /** Sync apiMessages into the contextManager for token counting. */
    private _syncContext(): void {
        this.contextManager.setApiMessages([...this.apiMessages]);
    }

    /** Get a workspace-scoped storage path for chats. */
    private _getChatStoragePath(ctx: vscode.ExtensionContext): string {
        // Always use globalStorageUri as base so extension settings are portable.
        // Scope by workspace folder name so different projects get separate chat lists.
        const base = ctx.globalStorageUri.fsPath;
        this._globalStoragePath = base;

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            this._workspaceLabel = workspaceFolder.name;
            const folderName = workspaceFolder.name.replace(/[^a-zA-Z0-9_-]/g, '_');
            return path.join(base, 'chats', folderName);
        }

        // No workspace open — global scope
        this._workspaceLabel = '';
        // Also check if old-style chats exist at the root level
        return base;
    }

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly extensionContext: vscode.ExtensionContext
    ) {
        // Model manager first (needed for active model config)
        this.modelManager = new ModelManager(
            extensionContext,
            (msg) => this._post(msg),
            () => {
                const baseConfig = ApiClient.getConfig();
                const activeModel = this.modelManager.getActiveConfig();
                this.apiClient = new ApiClient(ApiClient.mergeConfig(baseConfig, activeModel));
            }
        );

        const baseConfig = ApiClient.getConfig();
        const activeModel = this.modelManager.getActiveConfig();
        const config = ApiClient.mergeConfig(baseConfig, activeModel);
        const vsconfig = vscode.workspace.getConfiguration('codeon');
        this.contextManager = new ContextManager(config);
        this.modeManager = new ModeManager(config.defaultMode);
        this.apiClient = new ApiClient(config);
        this.toolCallHandler = new ToolCallHandler(
            config.openCodeEnabled,
            vsconfig.get<string>('approvalThreshold') || 'moderate',
            vsconfig.get<number>('commandTimeout') || 30,
            vsconfig.get<string[]>('commandBlocklist') || ['rm -rf', ':(){ :|:};', 'mkfs', 'dd if=']
        );

        // Initialize approval store for workspace-level auto-approval rules
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            this.toolCallHandler.initWorkspace(workspaceRoot);
        }
        // P6-T14: sub-agent tool calls go through this handler's own guardrails
        this.toolCallHandler.wireSubAgentToolExecution();
        this.chatStore = new ChatStore(this._getChatStoragePath(extensionContext), extensionContext.globalStorageUri.fsPath, this._workspaceLabel);

        // Observability: request logging + stats
        this.observability = new ObservabilityService(extensionContext.globalStorageUri.fsPath);
        this.observability.onStatsUpdate((stats: SessionStats) => {
            this._post({
                command: 'sessionStats',
                requestCount: stats.requestCount,
                totalTokens: stats.totalInputTokens + stats.totalOutputTokens,
                avgLatencyMs: stats.avgLatencyMs,
                errorCount: stats.errorCount,
                errorRate: stats.errorRate,
            });
        });

        // Chat manager (for chat lifecycle)
        this.chatManager = new ChatManager(
            this.chatStore,
            this.modeManager,
            this.contextManager,
            this.apiMessages,
            (msg) => this._post(msg),
            () => this.activeChatId,
            (id) => { this.activeChatId = id; },
            (activeId) => this._postChatList(ChatStore.listAllChats(this._globalStoragePath))
        );

        // Conversation manager (send/receive loop, trimming, summarization, regeneration, stop)
        this.conversationManager = new ConversationManager(
            this.apiMessages,
            () => this.apiClient,
            (client) => { this.apiClient = client; },
            () => this.toolCallHandler,
            (handler) => { this.toolCallHandler = handler; },
            this.contextManager,
            this.modeManager,
            this.chatStore,
            this.retrievalService,
            this.observability,
            () => this._webviewView as vscode.WebviewPanel | undefined,
            (msg) => this._post(msg),
            () => this.isProcessing,
            (v) => { this.isProcessing = v; },
            () => this.abortController,
            (c) => { this.abortController = c; },
            () => this.activeChatId,
            () => this.modelManager.getActiveConfig()
        );

        // Message router (routes webview messages to handlers).
        // A-4: a named handlers object instead of 29 positional callback
        // params — see MessageRouterHandlers' doc comment for why the
        // positional form was a real correctness risk, not just noise.
        this.messageRouter = new MessageRouter({
            onSendMessage: (text, mode) => this._handleSendMessage(text, mode),
            onForceSendMessage: (text, mode) => this._handleForceSendMessage(text, mode),
            onAttachFile: (filePath, fileName, fileContent) => this._handleAttachFile(filePath, fileName, fileContent),
            onGetConfig: () => this._handleGetConfig(),
            onListModels: () => this._handleListModels(),
            onSwitchModel: (modelName, providerName) => this._handleSwitchModel(modelName, providerName),
            onAddModel: (providerName, providerEndpoint, providerApiKey, modelName) => this._handleAddModel(providerName, providerEndpoint, providerApiKey, modelName),
            onBulkAddModels: (providerName, providerEndpoint, providerApiKey, modelNames) => this._handleBulkAddModels(providerName, providerEndpoint, providerApiKey, modelNames),
            onAddModelToProvider: (modelName, providerName) => this._handleAddModelToProvider(modelName, providerName),
            onUpdateProvider: (providerName, providerEndpoint, providerApiKey) => this._handleUpdateProvider(providerName, providerEndpoint, providerApiKey),
            onUpdateModel: (oldModelName, oldProviderName, newModelName, newProviderName, providerEndpoint, providerApiKey, nickname) =>
                this._handleUpdateModel(oldModelName, oldProviderName, newModelName, newProviderName, providerEndpoint, providerApiKey, nickname),
            onDeleteModel: (modelName, providerName) => this._handleDeleteModel(modelName, providerName),
            onDeleteProvider: (providerName) => this._handleDeleteProvider(providerName),
            onResetAllModels: () => this._handleResetAllModels(),
            onNewChat: () => this._createNewChat(),
            onSwitchChat: (chatId) => this._switchChat(chatId),
            onDeleteChat: (chatId) => this._deleteChat(chatId),
            onRenameChat: (chatId, title) => this._renameChat(chatId, title),
            onToolApprovalResponse: (toolId, approved, scope) => this._handleToolApprovalResponse(toolId, approved, scope),
            onRemoveRetrievedChunk: (filePath) => this.contextManager.removeRetrievedChunk(filePath),
            onRegenerate: () => this._handleRegenerate(),
            onCompact: () => this._handleCompact(),
            onStopGeneration: () => this._handleStop(),
            onSetEditMode: (message) => this._handleSetEditMode(message),
            onAcceptDiff: () => this.inlineEditProvider?.acceptCurrentDiff(),
            onRejectDiff: () => this.inlineEditProvider?.rejectCurrentDiff(),
            onQuestionResponse: (questionId, answer) => this._handleQuestionResponse(questionId, answer),
            onPlanModeExitRequest: (toolId) => this._handlePlanModeExitRequest(toolId),
            onPlanModeToolResponse: (toolId, approved) => this._handlePlanModeToolResponse(toolId, approved),
            onSetInteractionMode: (mode) => this._handleSetInteractionMode(mode),
            onExpandHistory: () => this._handleExpandHistory()
        });
        const chats = this.chatStore.listChats();
        if (chats.length === 0) {
            const first = this.chatStore.createChat(config.defaultMode);
            this.activeChatId = first.id;
        } else {
            this.activeChatId = chats[0].id;
        }
    }

    /** Inject the retrieval service (called from extension.ts after indexer is ready). */
    public setRetrievalService(service: RetrievalService | null): void {
        this.retrievalService = service;
    }

    /** Get the currently active model configuration. */
    public getModelConfig(): ActiveModelConfig | undefined {
        const cfg = this.modelManager.getActiveConfig();
        if (!cfg || !cfg.apiKey) return undefined;
        return cfg;
    }

    /** Inject the inline edit provider. */
    public setInlineEditProvider(provider: InlineEditProvider | null): void {
        this.inlineEditProvider = provider;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._webviewView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        // Only set HTML + message listener on first load — VS Code calls resolveWebviewView
        // every time the panel becomes visible, and resetting html destroys
        // the DOM (losing scroll position, input focus).
        if (!this._isWebviewInitialized) {
            webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
            this._isWebviewInitialized = true;

            // Send initial state after webview script finishes initializing.
            // Wait for the webview to signal it's ready, with a 2s fallback.
            const sendTimeout = setTimeout(() => {
                this._sendInitialState();
            }, 2000);

            this._webviewMessageDisposable = webviewView.webview.onDidReceiveMessage(
                (message: Record<string, unknown>) => {
                    if (message.command === 'webviewReady' && !this._hasSentInitialState) {
                        clearTimeout(sendTimeout);
                        this._hasSentInitialState = true;
                        this._sendInitialState();
                        return;
                    }
                    if (message.command === 'pong') {
                        // Webview is alive — sync state now
                        this._pendingSyncAfterPing = false;
                        this._syncStateToWebview();
                        return;
                    }
                    this._handleWebviewMessage(message);
                });
        }

        // Re-sync state whenever the panel becomes visible again.
        // Register outside the first-load guard so it fires even after re-init.
        // M-13: dispose any listener from a PRIOR resolveWebviewView() call
        // before registering a new one, so they don't stack.
        this._visibilityListenerDisposable?.dispose();
        this._visibilityListenerDisposable = webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                // Skip restore during active processing to avoid losing in-progress messages.
                if (!this.isProcessing) {
                    this._restoreActiveChat();
                }

                // Ping the webview to check if it's still alive.
                // Under memory pressure, retainContextWhenHidden can be overridden
                // by VS Code and the webview context silently dies.
                if (this._isWebviewInitialized) {
                    this._pendingSyncAfterPing = true;
                    this._post({ command: 'ping' });
                    // Fallback: if no pong within 1s, force re-init
                    setTimeout(() => {
                        if (this._pendingSyncAfterPing) {
                            this._pendingSyncAfterPing = false;
                            this._forceReinitWebview(webviewView);
                        }
                    }, 1000);
                } else {
                    this._syncStateToWebview();
                }
            }
        }, undefined, this.extensionContext.subscriptions);

        // On every resolveWebviewView call: restore active chat and sync.
        // Skip restore during active processing to avoid losing in-progress messages.
        if (!this.isProcessing) {
            this._restoreActiveChat();
        }
        if (this._isWebviewInitialized) {
            this._syncStateToWebview();
        }
    }

    /** Forcefully re-initialize the webview when its context was destroyed. */
    private _forceReinitWebview(webviewView: vscode.WebviewView): void {
        // Dispose old message listener to avoid stacking duplicates
        if (this._webviewMessageDisposable) {
            this._webviewMessageDisposable.dispose();
            this._webviewMessageDisposable = null;
        }
        this._isWebviewInitialized = false;
        this._hasSentInitialState = false;

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        this._isWebviewInitialized = true;

        const sendTimeout = setTimeout(() => {
            this._sendInitialState();
        }, 2000);

        this._webviewMessageDisposable = webviewView.webview.onDidReceiveMessage(
            (message: Record<string, unknown>) => {
                if (message.command === 'webviewReady' && !this._hasSentInitialState) {
                    clearTimeout(sendTimeout);
                    this._hasSentInitialState = true;
                    this._sendInitialState();
                    // Re-send any pending tool approval so the card renders in the fresh webview
                    this._repostPendingApprovals();
                    return;
                }
                if (message.command === 'pong') {
                    this._pendingSyncAfterPing = false;
                    this._syncStateToWebview();
                    return;
                }
                this._handleWebviewMessage(message);
            });
    }

    /**
     * Get messages for display in the webview.
     * Prefers the full transcript when available (after compaction) so the UI
     * shows the complete conversation history instead of compacted apiMessages
     * with system-level summary blocks that the webview skips.
     */
    private _getDisplayMessages(): Array<Record<string, unknown>> {
        const transcript = this.conversationManager.getContextSnapshot();
        // Use transcript if it has more messages than apiMessages (i.e., compaction occurred).
        const source = transcript.length > this.apiMessages.length ? transcript : this.apiMessages;
        const msgs: Array<Record<string, unknown>> = source.map(m => ({
            role: m.role,
            content: m.content,
            tool_call_id: m.tool_call_id,
            tool_calls: m.tool_calls
        }));
        // Append interrupted partial tail if present
        if (this.chatManager.partialTailMessage) {
            msgs.push({ role: 'assistant', content: this.chatManager.partialTailMessage.content, _partial: true });
        }
        return msgs;
    }

    /**
     * Re-send chat state (messages, token count, model list) to the webview.
     * Used after visibility toggles when the browser may have reset webview DOM.
     * Always re-restores from storage first so apiMessages is never stale.
     */
    private _syncStateToWebview(): void {
        if (!this._webviewView) return;

        // Re-restore from storage RIGHT BEFORE reading apiMessages.
        // This prevents sending stale data when a switchChat message was
        // processed between the visibility-change restore and this sync.
        // Skip during active processing to avoid losing in-progress messages.
        if (!this.isProcessing) {
            this._restoreActiveChat();
        }

        // Re-send messages for the active chat — use display messages (transcript-aware).
        const msgs = this._getDisplayMessages();

        this._post({
            command: 'activeChatChanged',
            chatId: this.activeChatId,
        });

        this._post({
            command: 'loadMessages',
            messages: msgs,
            mode: this.modeManager.getCurrentMode(),
            assistantName: this._resolveAssistantName(),
            forceReload: true,
            // Tell the webview whether a turn is still genuinely in flight, so
            // its forceReload handler doesn't blindly clear isProcessing and
            // hide the Stop button for a turn that's still running — that
            // desync previously caused every subsequent toolCall/toolResult
            // event to be dropped (they're gated on isProcessing), leaving the
            // chat looking permanently stuck after a visibility toggle.
            processing: this.isProcessing,
            hasTranscript: this.conversationManager.getContextSnapshot().length > this.apiMessages.length,
        });

        // Re-assert the authoritative processing/button state as a follow-up,
        // independent of how the webview's loadMessages handler chose to react
        // above — belt-and-braces so a visibility toggle can never leave the
        // Stop/Send button out of sync with whether a turn is actually running.
        this._post({ command: 'processingState', processing: this.isProcessing });

        // Re-send token count
        const config = ApiClient.getConfig();
        this._post({
            command: 'tokenCount',
            used: this.contextManager.getContextSize(),
            limit: config.contextWindowSize
        });

        // Re-send model list (ensures dropdown stays populated)
        this._handleListModels();
    }

    private _handleWebviewMessage(message: Record<string, unknown>): void {
        // Handle VSCode commands directly (router doesn't know about vscode)
        switch (message.command) {
            case 'openSettings':
                vscode.commands.executeCommand('workbench.action.openSettings', 'codeon');
                return;
            case 'openLogs':
                vscode.commands.executeCommand('codeon.showLogs');
                return;
            case 'stopAgent': {
                const agentId = String(message.agentId || '');
                if (agentId) {
                    this.conversationManager.stopAgent(agentId);
                }
                return;
            }
            case 'rebuildIndex':
                vscode.commands.executeCommand('codeon.rebuildIndex');
                return;
            case 'openFile': {
                const relPath = String(message.relPath || '');
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (workspaceFolder && relPath) {
                    const target = path.join(workspaceFolder.uri.fsPath, relPath);
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
                }
                return;
            }
            case 'showDiff': {
                const relPath = String(message.relPath || '');
                const oldContent = String(message.oldContent || '');
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (workspaceFolder && relPath) {
                    const target = path.join(workspaceFolder.uri.fsPath, relPath);
                    // Write old content to a temp file for comparison
                    const tempUri = vscode.Uri.joinPath(
                        this.extensionContext.globalStorageUri,
                        `.diff-${Date.now()}.tmp`
                    ).fsPath;
                    fs.writeFileSync(tempUri, oldContent, 'utf8');
                    this._pendingTempDiffFiles.add(tempUri);
                    // Open VS Code comparison view
                    vscode.commands.executeCommand('vscode.diff',
                        vscode.Uri.file(tempUri),
                        vscode.Uri.file(target),
                        `${relPath}: before ↔ after`
                    );
                    // Clean up temp file after a delay
                    setTimeout(() => {
                        fs.unlink(tempUri, () => {});
                        this._pendingTempDiffFiles.delete(tempUri);
                    }, 30000);
                }
                return;
            }
        }
        this.messageRouter.route(message);
    }

    private _sendInitialState(): void {
        if (!this._webviewView) return;

        // Send config first so the loading spinner hides immediately.
        this._handleGetConfig();

        // Send chat list (all workspaces)
        this._postChatList(ChatStore.listAllChats(this._globalStoragePath));

        // Send current messages — prefer the full transcript for display when available.
        // After compaction, apiMessages contains summary blocks (role: system) that
        // the webview skips, resulting in a blank chat. The transcript preserves the
        // full pre-compaction history for correct display.
        const displayMessages = this._getDisplayMessages();
        const hasTranscript = this.conversationManager.getContextSnapshot().length > this.apiMessages.length;

        // Only force reload on first initialization — subsequent visibility
        // toggles should preserve approval cards, streaming state, etc.
        const isFirstLoad = !this._hasSentInitialState;
        this._hasSentInitialState = true;

        // Resolve assistant name for message rendering
        this._post({
            command: 'activeChatChanged',
            chatId: this.activeChatId,
        });

        this._post({
            command: 'loadMessages',
            messages: displayMessages,
            mode: this.modeManager.getCurrentMode(),
            assistantName: this._resolveAssistantName(),
            forceReload: isFirstLoad,
            hasTranscript,
        });

        // Send initial token count with correct context window from settings
        const config = ApiClient.mergeConfig(ApiClient.getConfig(), this.modelManager.getActiveConfig());
        this._post({
            command: 'tokenCount',
            used: this.contextManager.getContextSize(),
            limit: config.contextWindowSize
        });

        // Send model list for welcome screen (show configure CTA if empty)
        this._handleListModels();
    }

    private _restoreActiveChat(): void {
        this.chatManager.restoreActiveChat();
        // Initialize transcript from stored data so it's available for display expansion.
        const transcript = this.chatManager.getStoredTranscript();
        if (transcript) {
            this.conversationManager.initTranscriptFromMessages(transcript);
        } else {
            this.conversationManager.initTranscript();
        }
        // Sync context manager after restore so token count is accurate.
        this._syncContext();
    }

    private _createNewChat(): void {
        // Abort any in-flight request before creating a new chat,
        // otherwise the old turn keeps posting stream/tool/agent messages
        // into the new chat's webview and leaves isProcessing stuck.
        const previousChatId = this.activeChatId;
        if (this.isProcessing && this.abortController && previousChatId) {
            // Snapshot current messages NOW — the abort catch block saves
            // apiMessages asynchronously, but createNewChat below clears
            // the shared array synchronously. Without this snapshot the old
            // chat would be overwritten with an empty array on disk.
            this.chatStore.saveMessages(previousChatId, [...this.apiMessages]).catch((e) => console.warn('[ChatViewProvider] pre-abort save failed:', e));

            this.abortController.abort();
            this.abortController = null;
            this.isProcessing = false;
            // Immediately reset UI state so the new chat doesn't show "active".
            // The finally block in sendMessage will also post these but may be delayed.
            this._post({ command: 'processingState', processing: false });
            this._post({ command: 'hideStopBtn' });
        }
        this.chatManager.createNewChat();
        // Reset transcript so subsequent saves don't include stale messages from another chat.
        this.conversationManager.initTranscript();
        // Clear session-level auto-approvals for the new chat
        this.toolCallHandler.clearSessionAllowlist();
        // Reset status indicator to green "Ready" for the fresh chat
        this._post({ command: 'setStatus', state: 'done', text: 'Ready' });
        // Tell webview about the new active chat to filter stray messages
        this._post({ command: 'activeChatChanged', chatId: this.activeChatId });
        // Send fresh token count so the context ring resets with correct limit from settings
        const config = ApiClient.mergeConfig(ApiClient.getConfig(), this.modelManager.getActiveConfig());
        this._post({
            command: 'tokenCount',
            used: this.contextManager.getContextSize(),
            limit: config.contextWindowSize
        });
    }

    private _switchChat(chatId: string): void {
        // Abort in-flight request if switching chats during processing
        const previousChatId = this.activeChatId;
        const wasProcessing = this.isProcessing;
        if (wasProcessing && this.abortController && previousChatId) {
            // Snapshot current messages NOW — same race as _createNewChat:
            // the abort catch saves apiMessages async, but switchChat below
            // mutates the shared array synchronously via restoreActiveChat.
            this.chatStore.saveMessages(previousChatId, [...this.apiMessages]).catch((e) => console.warn('[ChatViewProvider] pre-abort save failed:', e));

            this.abortController.abort();
            this.abortController = null;
            this.isProcessing = false;
            // Immediately reset UI state so the new chat doesn't show "active".
            this._post({ command: 'processingState', processing: false });
            this._post({ command: 'hideStopBtn' });
        }
        // Clear session-level auto-approvals when switching chats
        this.toolCallHandler.clearSessionAllowlist();

        // Tell the webview which chat is now active so it can filter out
        // stray messages (streamChunk, toolCall, toolResult, agentProgress)
        // that may arrive late from the previous chat's still-resolving promises.
        this._post({ command: 'activeChatChanged', chatId });

        this.chatManager.switchChat(chatId);
        // Reset transcript so subsequent saves use the correct chat's messages.
        // Load stored transcript if available for display expansion.
        const transcript = this.chatManager.getStoredTranscript();
        if (transcript) {
            this.conversationManager.initTranscriptFromMessages(transcript);
        } else {
            this.conversationManager.initTranscript();
        }

        // Re-send display messages with transcript-aware content.
        // chatManager.switchChat() already sent loadMessages with apiMessages,
        // but those may be compacted. Override with full transcript for correct display.
        const displayMsgs = this._getDisplayMessages();
        const hasTranscript = this.conversationManager.getContextSnapshot().length > this.apiMessages.length;
        this._post({
            command: 'loadMessages',
            messages: displayMsgs,
            mode: this.modeManager.getCurrentMode(),
            assistantName: this._resolveAssistantName(),
            forceReload: true,
            hasTranscript,
        });

        // Send fresh token count so the context ring updates with correct limit from settings
        const config = ApiClient.mergeConfig(ApiClient.getConfig(), this.modelManager.getActiveConfig());
        this._post({
            command: 'tokenCount',
            used: this.contextManager.getContextSize(),
            limit: config.contextWindowSize
        });

        // Reset status indicator for the restored chat
        this._post({ command: 'setStatus', state: 'done', text: 'Ready' });
    }

    private _deleteChat(chatId: string): void {
        // H-9: await the now-async, mutex-protected delete before reading
        // this.apiMessages/transcript back below — deleteChat's own internal
        // switchChat()/createNewChat() (if the deleted chat was active)
        // mutates that state, so reading it before the delete settles could
        // render the wrong (stale or half-switched) chat.
        this.chatManager.deleteChat(chatId).then(() => {
            // Re-send display messages (transcript-aware) so compacted chats render correctly.
            if (this._webviewView) {
                const displayMsgs = this._getDisplayMessages();
                const hasTranscript = this.conversationManager.getContextSnapshot().length > this.apiMessages.length;
                this._post({
                    command: 'loadMessages',
                    messages: displayMsgs,
                    mode: this.modeManager.getCurrentMode(),
                    assistantName: this._resolveAssistantName(),
                    forceReload: true,
                    hasTranscript,
                });
            }
        }).catch(err => console.error('[ChatViewProvider] deleteChat failed:', err));
    }

    private _renameChat(chatId: string, title: string): void {
        this.chatManager.renameChat(chatId, title)
            .catch(err => console.error('[ChatViewProvider] renameChat failed:', err));
    }

    public clearChat(): void {
        // M-4: mutate in place instead of reassigning — apiMessages is
        // constructed once and passed BY REFERENCE into both ChatManager and
        // ConversationManager's constructors, so `this.apiMessages = []`
        // broke that shared reference for both of them (they kept pointing
        // at the old, now-orphaned array). `.length = 0` mutates the same
        // array all three still share.
        this.apiMessages.length = 0;
        this.contextManager.clearContext();
        if (this._webviewView) {
            this._webviewView.webview.postMessage({ command: 'clearMessages' });
        }
    }

    private _handleToolApprovalResponse(toolId: string, approved: boolean, scope?: 'once' | 'session' | 'workspace'): void {
        this.toolCallHandler.resolveApproval(toolId, approved, scope);
    }

    /** Re-post any pending tool approvals after webview reinit so the card renders. */
    private _repostPendingApprovals(): void {
        this.toolCallHandler.repostPendingApprovals(this._webviewView?.webview);
    }

    private _handleQuestionResponse(questionId: string, answer: unknown): void {
        this.toolCallHandler.resolveQuestion(questionId, answer);
    }

    private _handlePlanModeExitRequest(toolId: string): void {
        // Switch out of plan mode
        this.modeManager.switchMode('build', true);
        this.toolCallHandler.setCurrentMode('build');
        // Resolve the pending block as approved
        this.toolCallHandler.resolvePlanBlock(toolId, true);
        // Update webview UI
        const activeModel = this.modelManager.getActiveConfig();
        if (this._webviewView) {
            this._webviewView.webview.postMessage({
                command: 'configLoaded',
                defaultMode: 'build',
                modelName: activeModel?.modelName,
                assistantName: this._resolveAssistantName()
            });
        }
    }

    private _handlePlanModeToolResponse(toolId: string, approved: boolean): void {
        this.toolCallHandler.resolvePlanBlock(toolId, approved);
    }

    private _handleSetInteractionMode(mode: string): void {
        // Map interaction mode to approval threshold
        const thresholdMap: Record<string, string> = {
            ask: 'safe',         // Ask before everything (current default)
            autoedit: 'moderate', // Auto-approve safe tools, prompt for edits/commands
            relaxed: 'dangerous', // Only prompt for dangerous commands
        };
        const threshold = thresholdMap[mode] || 'safe';
        this.toolCallHandler.setApprovalThreshold(threshold);
        // Persist preference
        vscode.workspace.getConfiguration('codeon').update(
            'interactionMode',
            mode,
            true // Global scope
        );
        // Notify webview
        this._post({ command: 'interactionModeChanged', mode });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return getHtmlForWebview(this.extensionUri, webview);
    }

    private async _handleSendMessage(text: string, mode: string) {
        await this.conversationManager.sendMessage(text, mode);
    }

    private async _handleForceSendMessage(text: string, mode: string) {
        // Abort current turn if processing
        if (this.isProcessing) {
            this._handleStop();
            // Small delay to let the abort settle and DOM reset
            await new Promise(r => setTimeout(r, 400));
        }
        await this.conversationManager.sendMessage(text, mode);
    }

    private _handleAttachFile(filePath: string, fileName?: string, fileContent?: string) {
        if (!this._webviewView) {
            return;
        }

        try {
            let content = fileContent;
            let name = fileName;

            if (filePath && !content) {
                content = fs.readFileSync(filePath, 'utf8');
                name = path.basename(filePath);
            }

            if (!content || !name) {
                throw new Error('No file content provided');
            }

            this._post({
                command: 'fileAttached',
                fileName: name,
                fileContent: content
            });

            this.apiMessages.push({
                role: 'user',
                content: `Attached file "${name}":\n\n${content}`
            });
        } catch (error) {
            this._post({
                command: 'fileError',
                error: (error as Error).message || 'Failed to read file'
            });
        }
    }

    private _handleGetConfig() {
        const config = ApiClient.mergeConfig(ApiClient.getConfig(), this.modelManager.getActiveConfig());
        const vsconfig = vscode.workspace.getConfiguration('codeon');
        const modelNickname = config.modelName ? this.modelManager.getModelNickname(config.modelName) : undefined;
        this._post({
            command: 'configLoaded',
            modelEndpoint: config.modelEndpoint,
            modelName: config.modelName,
            modelNickname,
            assistantName: this._resolveAssistantName(),
            contextWindowSize: config.contextWindowSize,
            defaultMode: config.defaultMode,
            openCodeEnabled: config.openCodeEnabled,
            interactionMode: vsconfig.get<string>('interactionMode') || 'ask'
        });
    }

    /** List saved models from global state (grouped by provider). */
    private _handleListModels(): void {
        this.modelManager.listModels();
    }

    /** Switch to a saved model by name. */
    private _handleSwitchModel(modelName: string, providerName?: string): void {
        // H-8: switchModel awaits its globalState.update() internally now,
        // so this chain correctly waits for the write before reading the
        // (possibly new) active model name back for the assistant-name push.
        this.modelManager.switchModel(modelName, providerName)
            .then(() => this._pushAssistantName())
            .catch(err => console.error('[ChatViewProvider] switchModel failed:', err));
    }

    /** Resolve assistant name: custom setting > model nickname > model name > 'Assistant'. */
    private _resolveAssistantName(): string {
        const vsconfig = vscode.workspace.getConfiguration('codeon');
        const customAssistantName = vsconfig.get<string>('assistantName') || '';
        if (customAssistantName) return customAssistantName;

        const activeModel = this.modelManager.getActiveConfig();
        if (activeModel?.modelName) {
            const nickname = this.modelManager.getModelNickname(activeModel.modelName);
            if (nickname) return nickname;
            return activeModel.modelName.split('/').pop() || 'Assistant';
        }

        return 'Assistant';
    }

    /** Resolve and push the current assistant name to the webview. */
    private _pushAssistantName(): void {
        this._post({ command: 'assistantNameChanged', assistantName: this._resolveAssistantName() });
    }

    /** Called when settings change — refresh dependent UI in the webview. */
    public onSettingsChanged(): void {
        this._pushAssistantName();
        // Re-post token count so the context ring reflects any changed window size.
        const config = ApiClient.getConfig();
        this._post({
            command: 'tokenCount',
            used: this.contextManager.getContextSize(),
            limit: config.contextWindowSize,
        });
    }

    /** Add a new provider + model. */
    private _handleAddModel(providerName: string, providerEndpoint: string, providerApiKey: string, modelName: string, contextWindowSize?: number): void {
        this.modelManager.addModel(providerName, providerEndpoint, providerApiKey, modelName, contextWindowSize)
            .catch(err => console.error('[ChatViewProvider] addModel failed:', err));
    }

    /** Add multiple models under a single provider (each may have its own context window). */
    private _handleBulkAddModels(
        providerName: string,
        providerEndpoint: string,
        providerApiKey: string,
        modelSpecs: Array<{ name: string; contextWindowSize?: number }>
    ): void {
        this.modelManager.bulkAddModels(providerName, providerEndpoint, providerApiKey, modelSpecs)
            .catch(err => console.error('[ChatViewProvider] bulkAddModels failed:', err));
    }

    /** Add an existing model under a known provider. */
    private _handleAddModelToProvider(modelName: string, providerName: string, contextWindowSize?: number): void {
        this.modelManager.addModelToProvider(modelName, providerName, contextWindowSize)
            .catch(err => console.error('[ChatViewProvider] addModelToProvider failed:', err));
    }

    /** Update provider endpoint/apiKey. */
    private _handleUpdateProvider(providerName: string, providerEndpoint: string, providerApiKey: string): void {
        this.modelManager.updateProvider(providerName, providerEndpoint, providerApiKey)
            .catch(err => console.error('[ChatViewProvider] updateProvider failed:', err));
    }

    /** Update model name, provider assignment, and optionally provider details. */
    private _handleUpdateModel(
        oldModelName: string,
        oldProviderName: string,
        newModelName: string,
        newProviderName: string,
        providerEndpoint: string,
        providerApiKey: string,
        nickname?: string | null,
        contextWindowSize?: number
    ): void {
        this.modelManager.updateModel(oldModelName, oldProviderName, newModelName, newProviderName, providerEndpoint, providerApiKey, nickname, contextWindowSize)
            .then(() => this._pushAssistantName())
            .catch(err => console.error('[ChatViewProvider] updateModel failed:', err));
    }

    /** Delete a model from saved list. */
    private _handleDeleteModel(modelName: string, providerName: string): void {
        this.modelManager.deleteModel(modelName, providerName)
            .catch(err => console.error('[ChatViewProvider] deleteModel failed:', err));
    }

    /** Delete a provider and all its models. */
    private _handleDeleteProvider(providerName: string): void {
        this.modelManager.deleteProvider(providerName)
            .catch(err => console.error('[ChatViewProvider] deleteProvider failed:', err));
    }

    /** Reset all models/providers to clean state. */
    private _handleResetAllModels(): void {
        this.modelManager.resetAllModels().catch(err => console.error('resetAllModels failed:', err));
    }

    private _handleSetEditMode(message: Record<string, unknown>): void {
        const filePath = String(message.filePath || '');
        const selectedText = String(message.selectedText || '');
        const startLine = Number(message.startLine || 0);
        const endLine = Number(message.endLine || 0);

        // Pre-fill the chat input with edit context
        const prompt = `Edit the following code in ${filePath} (lines ${startLine}-${endLine}):\n\n\`\`\`\n${selectedText}\n\`\`\``;
        this._post({
            command: 'setEditMode',
            filePath,
            startLine,
            endLine,
            selectedText: prompt,
        });
    }

    /** Regenerate the last AI response by re-sending the last user message. */
    private _handleRegenerate(): void {
        this.conversationManager.regenerate();
    }

    /** Manually compact conversation context. */
    private async _handleCompact(): Promise<void> {
        await this.conversationManager.compact();
    }

    /** Stop current generation. */
    private _handleStop(): void {
        this.conversationManager.stop();
    }

    /** Reset the conversation: clear all messages and context. */
    public resetConversation(): void {
        this.conversationManager.resetConversation();
        // Create a fresh chat in the store
        this.chatManager.createNewChat();
        vscode.window.showInformationMessage('Conversation reset');
    }

    /**
     * Best-effort final save of the active chat's in-memory state, awaited by
     * extension.ts's deactivate() before the extension host tears down (P5-T6).
     * The normal per-turn saves already cover most cases; this exists for the
     * remaining gap between "last message pushed to apiMessages" and "that
     * message's save landed on disk" if deactivation happens in between.
     */
    public async flushPendingSaves(): Promise<void> {
        if (!this.activeChatId) return;
        try {
            await this.chatStore.saveMessages(this.activeChatId, [...this.apiMessages]);
        } catch (e) {
            console.warn('[ChatViewProvider] flush on deactivate failed:', e);
        }
    }

    /**
     * M-5: ChatViewProvider previously implemented only WebviewViewProvider,
     * with no dispose() at all — the observability onStatsUpdate callback
     * (registered once in the constructor) had no unsubscribe path, and
     * nothing called ObservabilityService's own dispose() (which disposes
     * its VS Code output channel). Called from extension.ts's deactivate().
     * Also disposes the visibility/message listeners (M-13) and cleans up
     * any temp diff files still pending (M-6).
     */
    public dispose(): void {
        this.observability.dispose();
        this._webviewMessageDisposable?.dispose();
        this._webviewMessageDisposable = null;
        this._visibilityListenerDisposable?.dispose();
        this._visibilityListenerDisposable = null;
        for (const tempFile of this._pendingTempDiffFiles) {
            try { fs.unlinkSync(tempFile); } catch { /* best effort */ }
        }
        this._pendingTempDiffFiles.clear();
    }

    /** Get pending approval count for status bar. */
    public getPendingApprovalCount(): number {
        return this.toolCallHandler?.getPendingApprovalCount() ?? 0;
    }

    /**
     * The real, actively-written-to request-log output channel — extension.ts's
     * "Show Request Logs" command previously created its own separate,
     * identically-named ('Chat Assistant') but never-written-to OutputChannel
     * instead of this one, so the command showed a permanently blank panel.
     */
    public getObservabilityChannel(): vscode.OutputChannel {
        return this.observability.getOutputChannel();
    }

    private _postChatList(chats: ChatIndexEntry[]): void {
        this._post({
            command: 'chatList',
            chats: chats.map(c => ({
                id: c.id,
                title: c.title,
                mode: c.mode,
                updatedAt: c.updatedAt,
                workspaceLabel: c.workspaceLabel
            })),
            activeChatId: this.activeChatId
        });
    }

    private _post(message: Record<string, unknown>) {
        if (this._webviewView) {
            this._webviewView.webview.postMessage(message);
        }
    }

    /** Expand the full transcript history in the UI. */
    private _handleExpandHistory(): void {
        const transcript = this.conversationManager.getContextSnapshot();
        if (!transcript || transcript.length === 0) return;

        const msgs: Array<Record<string, unknown>> = transcript.map(m => ({
            role: m.role,
            content: m.content,
            tool_call_id: m.tool_call_id,
            tool_calls: m.tool_calls
        }));

        this._post({
            command: 'expandHistory',
            messages: msgs,
        });
    }
}
