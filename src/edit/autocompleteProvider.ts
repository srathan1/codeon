import * as vscode from 'vscode';
import { ApiClient } from '../api/apiClient';
import { ChatConfig } from '../types';

/** Language extensions that should NOT trigger autocomplete. */
const EXCLUDED_LANGUAGES = new Set(['markdown', 'plaintext', 'json', 'yaml', 'yml', 'git-commit', 'log']);

/** Maximum lines of context to send per request. */
const MAX_CONTEXT_LINES = 100;

/**
 * Autocomplete provider using VS Code's InlineCompletionItem API.
 *
 * On trigger (typing or Tab), extracts prefix/suffix context from cursor position,
 * sends a FIM (fill-in-the-middle) request to the LLM, and renders ghost text.
 *
 * Debouncing: cancels pending request if user types again within debounce window.
 *
 * Acceptance tracking (P0-T5): Tracks whether the user typed the suggested text
 * after it was shown. Uses a time-window heuristic — if the user's next typed
 * characters match the completion within 2 seconds, count as accepted.
 */
export class AutocompleteProvider implements vscode.InlineCompletionItemProvider {
    private apiClient: ApiClient;
    private debounceMs: number;
    private contextLines: number;
    private autocompleteModel?: string;

    /** Timer for debouncing requests. */
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    /** Token for cancelling in-flight requests. */
    private abortController: AbortController | null = null;

    /** Acceptance tracking. */
    private requestedCount = 0;
    private acceptedCount = 0;

    /** Last completion shown — used for acceptance detection. */
    private lastCompletionText: string | null = null;
    private lastCompletionPosition: vscode.Position | null = null;
    private lastCompletionDocumentUri: vscode.Uri | null = null;
    private acceptanceTimer: ReturnType<typeof setTimeout> | null = null;

    /** Disposable for the text change listener used in acceptance tracking. */
    private _acceptanceListener: vscode.Disposable | null = null;

    constructor(config: ChatConfig) {
        this.apiClient = new ApiClient(config);
        this.debounceMs = config.contextWindowSize > 0 ? 200 : 200; // default
        this.contextLines = 50;
        this.readSettings();
        this.startAcceptanceTracking();
    }

    /** Start listening for text changes to detect autocomplete acceptance. */
    private startAcceptanceTracking(): void {
        this._acceptanceListener = vscode.workspace.onDidChangeTextDocument((event) => {
            if (!this.lastCompletionText || !this.lastCompletionPosition || !this.lastCompletionDocumentUri) {
                return;
            }

            // Only check changes in the same document
            if (event.document.uri.toString() !== this.lastCompletionDocumentUri.toString()) {
                return;
            }

            for (const change of event.contentChanges) {
                // Check if the change starts at our completion position
                if (change.range.start.line === this.lastCompletionPosition.line &&
                    change.range.start.character === this.lastCompletionPosition.character) {
                    // Check if the typed text matches the beginning of our completion
                    if (change.text.startsWith(this.lastCompletionText) ||
                        this.lastCompletionText.startsWith(change.text)) {
                        // User typed something matching our suggestion — count as accepted
                        if (change.text.length >= Math.min(this.lastCompletionText.length, 3)) {
                            this.acceptedCount++;
                            this.clearPendingAcceptance();
                            return;
                        }
                    }
                }
            }
        });
    }

    /** Clear the pending acceptance tracking state. */
    private clearPendingAcceptance(): void {
        this.lastCompletionText = null;
        this.lastCompletionPosition = null;
        this.lastCompletionDocumentUri = null;
        if (this.acceptanceTimer) {
            clearTimeout(this.acceptanceTimer);
            this.acceptanceTimer = null;
        }
    }

    /** Re-read settings from VS Code configuration. */
    readSettings(): void {
        const cfg = vscode.workspace.getConfiguration('codeon');
        this.debounceMs = cfg.get<number>('autocompleteDebounceMs', 200);
        this.contextLines = cfg.get<number>('autocompleteContextLines', 50);
        const model = cfg.get<string>('autocompleteModel', '');
        this.autocompleteModel = model || undefined;
    }

    /** Update API config (e.g., when settings change). */
    updateConfig(config: ChatConfig): void {
        this.apiClient = new ApiClient(config);
        this.readSettings();
    }

    /**
     * Provide inline completions at the given document position.
     * Called by VS Code on trigger (typing, Tab, or manual invocation).
     */
    provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
        // Skip excluded languages
        if (EXCLUDED_LANGUAGES.has(document.languageId)) {
            return { items: [] };
        }

        // Extract prefix and suffix context
        const { prefix, suffix } = this.extractContext(document, position);

        // Don't request if there's no meaningful prefix (cursor at BOF)
        if (!prefix.trim()) {
            return { items: [] };
        }

        // Cancel any pending request
        this.cancelPendingRequest();

        // Debounce: wait for user to stop typing before sending request
        return new Promise<vscode.InlineCompletionList>((resolve) => {
            this.debounceTimer = setTimeout(async () => {
                this.debounceTimer = null;

                try {
                    this.requestedCount++;

                    // Send FIM request
                    const completion = await this.apiClient.sendCompletionRequest(
                        prefix,
                        suffix,
                        this.autocompleteModel
                    );

                    if (!completion) {
                        resolve({ items: [] });
                        return;
                    }

                    // Post-process: strip leading/trailing whitespace that matches document
                    const cleaned = this.cleanCompletion(completion, prefix, suffix);
                    if (!cleaned) {
                        resolve({ items: [] });
                        return;
                    }

                    // Check if completion matches what's already in the document
                    const existingText = document.getText(
                        new vscode.Range(position, this.getCompletionEndPosition(document, position, cleaned))
                    );
                    if (existingText === cleaned) {
                        resolve({ items: [] });
                        return;
                    }

                    const item = new vscode.InlineCompletionItem(
                        cleaned,
                        new vscode.Range(position, this.getCompletionEndPosition(document, position, cleaned))
                    );

                    // Track this completion for acceptance detection (P0-T5)
                    this.lastCompletionText = cleaned;
                    this.lastCompletionPosition = position;
                    this.lastCompletionDocumentUri = document.uri;

                    // Clear pending acceptance after timeout (user didn't type the suggestion)
                    if (this.acceptanceTimer) {
                        clearTimeout(this.acceptanceTimer);
                    }
                    this.acceptanceTimer = setTimeout(() => {
                        this.clearPendingAcceptance();
                    }, 2000);

                    resolve({ items: [item] });
                } catch (err) {
                    console.warn('Autocomplete request failed:', err);
                    resolve({ items: [] });
                }
            }, this.debounceMs);
        });
    }

    /** Get current acceptance rate (0-1). */
    getAcceptanceRate(): number {
        if (this.requestedCount === 0) return 0;
        return this.acceptedCount / this.requestedCount;
    }

    /** Get raw stats. */
    getStats(): { requested: number; accepted: number; rate: number } {
        return {
            requested: this.requestedCount,
            accepted: this.acceptedCount,
            rate: this.getAcceptanceRate()
        };
    }

    /** Dispose resources. */
    dispose(): void {
        this.cancelPendingRequest();
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.clearPendingAcceptance();
        if (this._acceptanceListener) {
            this._acceptanceListener.dispose();
            this._acceptanceListener = null;
        }
    }

    // --- Private helpers ---

    private cancelPendingRequest(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    /**
     * Extract prefix (before cursor) and suffix (after cursor) context.
     * Limits to configured number of lines for each.
     */
    private extractContext(document: vscode.TextDocument, position: vscode.Position): { prefix: string; suffix: string } {
        // Prefix: from start of visible range or N lines back
        const startLine = Math.max(0, position.line - this.contextLines);
        const startPosition = new vscode.Position(startLine, 0);
        const prefix = document.getText(new vscode.Range(startPosition, position));

        // Suffix: from cursor to end of visible range or N lines forward
        const endLine = Math.min(document.lineCount - 1, position.line + this.contextLines);
        const endPosition = new vscode.Position(endLine, document.lineAt(endLine).text.length);
        const suffix = document.getText(new vscode.Range(position, endPosition));

        return { prefix, suffix };
    }

    /**
     * Clean up the completion text:
     * - Remove trailing whitespace that would be redundant
     * - Ensure it doesn't duplicate existing content
     */
    private cleanCompletion(completion: string, _prefix: string, _suffix: string): string {
        // Remove trailing whitespace — the user will add their own newlines
        let cleaned = completion.replace(/\s+$/, '');

        // Cap at reasonable length (don't suggest entire files)
        const maxChars = MAX_CONTEXT_LINES * 80; // ~80 chars per line
        if (cleaned.length > maxChars) {
            cleaned = cleaned.slice(0, maxChars);
            // Cut at line boundary
            const lastNewline = cleaned.lastIndexOf('\n');
            if (lastNewline > 0) {
                cleaned = cleaned.slice(0, lastNewline + 1);
            }
        }

        return cleaned;
    }

    /**
     * Calculate the end position of the completion for the replacement range.
     * This is used by VS Code to determine what gets replaced on accept.
     */
    private getCompletionEndPosition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _completion: string
    ): vscode.Position {
        // Simple heuristic: the completion replaces from cursor to end of current line
        // VS Code handles the actual insertion/replacement
        const line = document.lineAt(position.line);
        return new vscode.Position(position.line, line.text.length);
    }
}
