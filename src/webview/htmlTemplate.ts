import * as vscode from 'vscode';
import * as path from 'path';

/** Generate the full HTML for the chat webview. */
export function getHtmlForWebview(extensionUri: vscode.Uri, webview: vscode.Webview): string {
    const mediaPath = path.join(extensionUri.fsPath, 'media');
    const styleResetUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'reset.css')));
    const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'vscode.css')));
    const styleMainUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'main.css')));
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'main.js')));
    const logoUri = webview.asWebviewUri(vscode.Uri.file(path.join(mediaPath, 'icon.png')));

    // P6-T9: restrictive Content-Security-Policy. Scripts and styles may load
    // only from the extension's own webview resources (main.js is external, so
    // no inline scripts are needed); inline style attributes are allowed
    // (the webview uses a handful). This blocks injected/inline script and any
    // network exfiltration, hardening against markdown/tool output that reaches
    // an innerHTML sink.
    const cspSource = webview.cspSource;
    const csp = [
        `default-src 'none'`,
        `img-src ${cspSource} data:`,
        `font-src ${cspSource}`,
        `style-src ${cspSource} 'unsafe-inline'`,
        `script-src ${cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="${csp}">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="${styleResetUri}" rel="stylesheet">
            <link href="${styleVSCodeUri}" rel="stylesheet">
            <link href="${styleMainUri}" rel="stylesheet">
            <title>CodeOn</title>
        </head>
        <body>
            <div class="chat-view">

                <!-- Top bar -->
                <div class="top-bar" id="topBar">
                    <div class="brand">
                        <span class="brand-dot" id="brandDot"></span>
                        <span id="brandLabel">Plan</span>
                    </div>
                    <div class="actions-right">
                        <button class="icon-btn" id="toggleChatList" title="Toggle chat list">☰</button>
                        <button class="icon-btn" id="newChatBtn" title="New chat">+</button>
                    </div>
                </div>

                <!-- Chat list panel (collapsible) -->
                <div class="chat-list-panel" id="chatListPanel">
                    <div class="chat-list" id="chatList"></div>
                </div>

                <!-- Messages -->
                <div class="messages-area" id="messages">
                    <!-- Loading spinner (hidden after first configLoaded) -->
                    <div class="loading-indicator" id="loadingIndicator">
                        <div class="loading-spinner"></div>
                        <div class="loading-text">Initializing...</div>
                    </div>
                    <div class="empty-state" id="emptyState" style="display:none;">
                        <img class="empty-icon" src="${logoUri}" alt="CodeOn">
                        <div class="empty-title" id="emptyTitle">How can I help?</div>
                        <div class="empty-subtitle" id="emptySubtitle">Ask a question, review code, debug an issue, or plan architecture.</div>
                        <div class="empty-configure" id="emptyConfigure" style="display:none;">
                            <div class="configure-message">No model configured yet.</div>
                            <button class="configure-btn" id="configureModelBtn">⚙ Configure Model</button>
                            <div class="configure-form" id="configureForm" style="display:none;">
                                <div class="configure-field">
                                    <label class="configure-label">Provider Name</label>
                                    <input type="text" id="configureProviderName" placeholder="e.g. OpenAI, Anthropic" autocomplete="off"/>
                                </div>
                                <div class="configure-field">
                                    <label class="configure-label">Endpoint URL</label>
                                    <input type="text" id="configureProviderEndpoint" placeholder="https://api.openai.com" autocomplete="off"/>
                                </div>
                                <div class="configure-field">
                                    <label class="configure-label">API Key</label>
                                    <input type="password" id="configureProviderApiKey" placeholder="sk-..." autocomplete="off"/>
                                </div>
                                <div class="configure-field">
                                    <label class="configure-label">Models</label>
                                    <div id="configureModelRows"></div>
                                    <button class="configure-add-btn" id="addModelRowBtn">+ Add Model</button>
                                </div>
                                <div class="configure-actions">
                                    <button class="configure-action-btn cancel" id="cancelConfigureBtn">Cancel</button>
                                    <button class="configure-action-btn save" id="saveConfigureBtn">Save &amp; Start</button>
                                </div>
                            </div>
                        </div>
                        <div class="empty-suggestions" id="emptySuggestions">
                            <div class="suggestion-chip" data-text="Explain the architecture of this project">Explain the architecture of this project</div>
                            <div class="suggestion-chip" data-text="Find and fix bugs in the current workspace">Find and fix bugs in the current workspace</div>
                            <div class="suggestion-chip" data-text="Write tests for the main module">Write tests for the main module</div>
                        </div>
                        <div class="empty-capabilities" id="emptyCapabilities">
                            <span class="capability-item">📄 Read files</span>
                            <span class="capability-item">🔍 Search code</span>
                            <span class="capability-item">✏️ Edit code</span>
                            <span class="capability-item">⚙️ Run commands</span>
                        </div>
                    </div>
                </div>

                <!-- Status line -->
                <div class="status-line" id="statusLine">
                    <span class="status-dot done" id="statusDot"></span>
                    <span class="status-text" id="statusText">Ready</span>
                </div>

                <!-- Attached files -->
                <div class="attached-files" id="attachedFiles"></div>

                <!-- Pending message queue (shown when AI is working) -->
                <div class="pending-message-bar" id="pendingMessageBar" style="display:none;">
                    <div class="pending-queue-header">
                        <span class="pending-queue-label">Queued messages</span>
                        <div class="pending-queue-actions">
                            <button class="pending-send-now" id="pendingSendNow" title="Interrupt AI & send first queued now">⚡ Send now</button>
                            <button class="pending-clear-all" id="pendingClearAll" title="Clear all queued">Clear all</button>
                        </div>
                    </div>
                    <div class="pending-queue-list" id="pendingQueueList"></div>
                </div>

                <!-- Live /compact progress — sticky above the composer for the same reason
                     as the approval bar below: it previously lived inline in the scrolling
                     chat, where it was immediately scrolled out of view by anyone looking
                     at the composer, making it look like there was "no status" at all. -->
                <div class="compact-progress-bar" id="compactProgressBar" style="display:none;"></div>

                <!-- Tool approval requests — sticky above the composer (not inline in the
                     scrolling chat) so a pending approval is never pushed out of view by
                     other tool calls/messages that stream in while it's still waiting. -->
                <div class="approval-bar" id="approvalBar"></div>

                <!-- Plan mode banner (tool blocked — requires user decision) -->
                <div class="plan-mode-banner" id="planModeBanner" style="display:none;">
                    <div class="plan-mode-banner-left">
                        <span class="plan-mode-banner-icon">🔒</span>
                        <span class="plan-mode-banner-text" id="planModeBannerText">Plan mode active — <span id="planModeToolName"></span> requires exiting plan mode</span>
                    </div>
                    <div class="plan-mode-banner-actions">
                        <button class="plan-mode-banner-btn reject" id="planModeBannerReject" title="Block tool">✕</button>
                        <button class="plan-mode-banner-btn exit" id="planModeBannerExit" title="Exit plan mode &amp; allow">Exit Plan Mode →</button>
                    </div>
                </div>

                <!-- Input area (composer) -->
                <div class="input-wrapper">
                    <div class="input-box">
                        <div class="input-textarea-row">
                            <input type="file" id="fileInput" style="display:none">
                            <button class="icon-btn attach-inline-btn" id="attachBtn" title="Attach file">&#128206;</button>
                            <textarea id="messageInput" rows="1" placeholder="Message (Enter to send, Shift+Enter for newline)"></textarea>
                        </div>
                        <div class="input-separator"></div>
                        <div class="input-footer">
                            <div class="input-left">
                                <!-- Group: how the request runs -->
                                <div class="composer-group composer-group-mode">
                                    <!-- Mode selector (first) -->
                                    <div class="mode-selector" id="modeSelector">
                                        <button class="mode-dropdown-btn" id="modeDropdownBtn">
                                            <span id="currentModeLabel">Plan</span>
                                            <span class="chevron">▾</span>
                                        </button>
                                        <div class="mode-dropdown" id="modeDropdown">
                                            <div class="mode-option" data-mode="plan">Plan</div>
                                            <div class="mode-option" data-mode="build">Build</div>
                                            <div class="mode-option" data-mode="code-review">Review</div>
                                            <div class="mode-option" data-mode="debug">Debug</div>
                                            <div class="mode-option" data-mode="research">Research</div>
                                        </div>
                                    </div>
                                    <!-- Interaction mode selector -->
                                    <div class="interaction-mode-selector" id="interactionModeSelector">
                                        <button class="interaction-mode-btn" id="interactionModeBtn" title="Approval level">
                                            <span id="interactionModeIcon">🔒</span>
                                            <span class="interaction-mode-label" id="interactionModeLabel">Ask all</span>
                                        </button>
                                        <div class="interaction-mode-dropdown" id="interactionModeDropdown">
                                            <div class="interaction-mode-option" data-mode="ask" title="Approve every action">🔒 Ask all</div>
                                            <div class="interaction-mode-option" data-mode="autoedit" title="Like Cursor - auto-approve reads &amp; edits, prompt for commands">✏️ Allow edits</div>
                                            <div class="interaction-mode-option" data-mode="relaxed" title="Like Claude --yes - only prompt for dangerous commands">⚡ Relaxed</div>
                                        </div>
                                    </div>
                                    <!-- Model selector -->
                                    <div class="model-selector" id="modelSelector">
                                        <button class="model-dropdown-btn" id="modelDropdownBtn">
                                            <span id="modelNameLabel">-</span>
                                            <span class="chevron">▾</span>
                                        </button>
                                        <div class="model-dropdown" id="modelDropdown">
                                            <div class="model-option" data-action="add">+ Add Model...</div>
                                        </div>
                                    </div>
                                </div>
                                <!-- Group: context/history -->
                                <div class="composer-group composer-group-context">
                                    <!-- Context ring -->
                                    <div class="context-ring" id="contextRing">
                                        <svg viewBox="0 0 36 36" width="26" height="26">
                                            <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--vscode-input-border, #3c3c3c)" stroke-width="3"/>
                                            <circle cx="18" cy="18" r="15.915" fill="none" stroke="var(--vscode-input-foreground, #cccccc)" stroke-width="3"
                                                stroke-dasharray="0 100" stroke-linecap="round" id="contextRingProgress"
                                                transform="rotate(-90 18 18)"/>
                                        </svg>
                                        <span class="context-ring-label" id="contextRingLabel"></span>
                                        <div class="context-tooltip" id="contextTooltip">
                                            <span id="ctxUsageLine">0 / 0 tokens used</span>
                                        </div>
                                    </div>
                                    <!-- Expand history button (shown when transcript available) -->
                                    <button class="icon-btn expand-history-btn" id="expandHistoryBtn" title="Expand compacted history" style="display:none">&#8645;</button>
                                </div>
                            </div>
                            <div class="input-right">
                                <button class="icon-btn" id="settingsBtn" title="Settings">&#9881;</button>
                                <button class="send-btn" id="sendBtn" title="Send">&#9654;</button>
                                <button class="stop-btn" id="stopBtn" title="Stop" style="display:none">&#9632;</button>
                            </div>
                        </div>
                    </div>
                </div>

            </div>
            <script type="module" src="${scriptUri}"></script>
        </body>
        </html>`;
}
