/**
 * Handler callbacks for every webview command MessageRouter dispatches.
 *
 * A-4/A-2: previously a 29-parameter positional constructor — the most
 * extreme instance of the manual-callback-DI pattern flagged elsewhere in
 * the codebase (ConversationManager's 18-param constructor is the other).
 * Positional params this deep are also a correctness risk on their own:
 * several adjacent parameters share the exact same call signature (e.g.
 * onAcceptDiff/onRejectDiff, onRegenerate/onCompact/onStopGeneration are all
 * `() => void`), so a construction-site reordering mistake would type-check
 * fine and silently wire the wrong handler to the wrong command. A named
 * object makes that class of mistake structurally impossible and makes the
 * router trivially constructible with a partial/mock handler set in tests.
 */
export interface MessageRouterHandlers {
    onSendMessage: (text: string, mode: string) => void;
    onForceSendMessage: (text: string, mode: string) => void;
    onAttachFile: (filePath: string, fileName: string, fileContent: string) => void;
    onGetConfig: () => void;
    onListModels: () => void;
    onSwitchModel: (modelName: string, providerName?: string) => void;
    onAddModel: (providerName: string, providerEndpoint: string, providerApiKey: string, modelName: string, contextWindowSize?: number) => void;
    onBulkAddModels: (providerName: string, providerEndpoint: string, providerApiKey: string, modelSpecs: Array<{ name: string; contextWindowSize?: number }>) => void;
    onAddModelToProvider: (modelName: string, providerName: string, contextWindowSize?: number) => void;
    onUpdateProvider: (providerName: string, providerEndpoint: string, providerApiKey: string) => void;
    onUpdateModel: (oldModelName: string, oldProviderName: string, newModelName: string, newProviderName: string, providerEndpoint: string, providerApiKey: string, nickname?: string | null, contextWindowSize?: number) => void;
    onDeleteModel: (modelName: string, providerName: string) => void;
    onDeleteProvider: (providerName: string) => void;
    onResetAllModels: () => void;
    onNewChat: () => void;
    onSwitchChat: (chatId: string) => void;
    onDeleteChat: (chatId: string) => void;
    onRenameChat: (chatId: string, title: string) => void;
    onToolApprovalResponse: (toolId: string, approved: boolean, scope?: 'once' | 'session' | 'workspace') => void;
    onRemoveRetrievedChunk: (filePath: string) => void;
    onRegenerate: () => void;
    onCompact: () => void;
    onStopGeneration: () => void;
    onSetEditMode: (message: Record<string, unknown>) => void;
    onAcceptDiff: () => void;
    onRejectDiff: () => void;
    onQuestionResponse: (questionId: string, answer: unknown) => void;
    onPlanModeExitRequest: (toolId: string) => void;
    onPlanModeToolResponse: (toolId: string, approved: boolean) => void;
    onSetInteractionMode: (mode: string) => void;
    onExpandHistory: () => void;
}

/** Route webview messages to their respective handlers. */
export class MessageRouter {
    constructor(private readonly handlers: MessageRouterHandlers) {}

    public route(message: Record<string, unknown>): void {
        const h = this.handlers;
        switch (message.command) {
            case 'sendMessage':
                h.onSendMessage(String(message.text || ''), String(message.mode || 'plan'));
                break;
            case 'forceSendMessage':
                // Abort current turn if processing, then send new message
                h.onForceSendMessage(String(message.text || ''), String(message.mode || 'plan'));
                break;
            case 'attachFile':
                h.onAttachFile(String(message.filePath || ''), String(message.fileName || ''), String(message.fileContent || ''));
                break;
            case 'getConfig':
                h.onGetConfig();
                break;
            case 'listModels':
                h.onListModels();
                break;
            case 'switchModel':
                h.onSwitchModel(String(message.modelName || ''), message.providerName ? String(message.providerName) : undefined);
                break;
            case 'addModel':
                h.onAddModel(
                    String(message.providerName || ''),
                    String(message.providerEndpoint || ''),
                    String(message.providerApiKey || ''),
                    String(message.modelName || ''),
                    typeof message.contextWindowSize === 'number' ? message.contextWindowSize : undefined
                );
                break;
            case 'bulkAddModels':
                h.onBulkAddModels(
                    String(message.providerName || ''),
                    String(message.providerEndpoint || ''),
                    String(message.providerApiKey || ''),
                    Array.isArray(message.models)
                        ? message.models.map((m: unknown) => {
                            const spec = m as { name?: unknown; contextWindowSize?: unknown };
                            return {
                                name: String(spec?.name || ''),
                                contextWindowSize: typeof spec?.contextWindowSize === 'number' ? spec.contextWindowSize : undefined,
                            };
                        }).filter(s => s.name)
                        // Back-compat: older webview builds may still send `modelNames: string[]`.
                        : Array.isArray(message.modelNames)
                            ? message.modelNames.map((n: unknown) => ({ name: String(n) }))
                            : []
                );
                break;
            case 'addModelToProvider':
                h.onAddModelToProvider(
                    String(message.modelName || ''),
                    String(message.providerName || ''),
                    typeof message.contextWindowSize === 'number' ? message.contextWindowSize : undefined
                );
                break;
            case 'updateProvider':
                h.onUpdateProvider(
                    String(message.providerName || ''),
                    String(message.providerEndpoint || ''),
                    String(message.providerApiKey || '')
                );
                break;
            case 'updateModel':
                h.onUpdateModel(
                    String(message.oldModelName || ''),
                    String(message.oldProviderName || ''),
                    String(message.newModelName || ''),
                    String(message.newProviderName || ''),
                    String(message.providerEndpoint || ''),
                    String(message.providerApiKey || ''),
                    message.nickname === null ? null : (message.nickname ? String(message.nickname) : undefined),
                    typeof message.contextWindowSize === 'number' ? message.contextWindowSize : undefined
                );
                break;
            case 'deleteModel':
                h.onDeleteModel(String(message.modelName || ''), String(message.providerName || ''));
                break;
            case 'deleteProvider':
                h.onDeleteProvider(String(message.providerName || ''));
                break;
            case 'resetAllModels':
                h.onResetAllModels();
                break;
            case 'newChat':
                h.onNewChat();
                break;
            case 'switchChat':
                h.onSwitchChat(String(message.chatId));
                break;
            case 'deleteChat':
                h.onDeleteChat(String(message.chatId));
                break;
            case 'renameChat':
                h.onRenameChat(String(message.chatId), String(message.title));
                break;
            case 'toolApprovalResponse': {
                const scope = message.scope as 'once' | 'session' | 'workspace' | undefined;
                h.onToolApprovalResponse(String(message.toolId), Boolean(message.approved), scope);
                break;
            }
            case 'removeRetrievedChunk':
                h.onRemoveRetrievedChunk(String(message.filePath));
                break;
            case 'openSettings':
                // vscode command — handled by caller
                break;
            case 'openLogs':
                // vscode command — handled by caller
                break;
            case 'rebuildIndex':
                // vscode command — handled by caller
                break;
            case 'regenerate':
                h.onRegenerate();
                break;
            case 'compact':
                h.onCompact();
                break;
            case 'stopGeneration':
                h.onStopGeneration();
                break;
            case 'setEditMode':
                h.onSetEditMode(message);
                break;
            case 'acceptDiff':
                h.onAcceptDiff();
                break;
            case 'rejectDiff':
                h.onRejectDiff();
                break;
            case 'questionResponse':
                h.onQuestionResponse(String(message.questionId), message.answer);
                break;
            case 'planModeExitRequest':
                h.onPlanModeExitRequest(String(message.toolId));
                break;
            case 'planModeToolResponse':
                h.onPlanModeToolResponse(String(message.toolId), Boolean(message.approved));
                break;
            case 'setInteractionMode':
                h.onSetInteractionMode(String(message.mode || 'ask'));
                break;
            case 'expandHistory':
                h.onExpandHistory();
                break;
            // 'openFile' and 'showDiff' are intentionally not routed here —
            // chatViewProvider.ts's _handleWebviewMessage handles both
            // directly (they need vscode.workspace/vscode.commands, which
            // this router doesn't otherwise depend on) before ever calling
            // route(), so a case here would be unreachable dead code.
        }
    }
}
