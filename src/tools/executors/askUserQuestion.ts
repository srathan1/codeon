import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';

/**
 * Ask the user a structured question via an inline card in the chat webview.
 * Uses the same pending-response pattern as tool approvals — and, like
 * approvals, it WAITS for the user rather than auto-answering on a timer.
 *
 * History: this used to auto-reject after 120s, which made the tool "fail"
 * and the model proceed without the user (perceived as the dialog "choosing
 * itself"), while the card was left stranded on screen. It now resolves only
 * when the user answers or the turn is cancelled (Stop / chat switch), matching
 * the approval flow.
 */
export class AskUserQuestionExecutor implements ToolExecutor {
    public name = 'ask_user_question';

    private _webview: vscode.Webview | undefined;
    private _abortSignal: AbortSignal | undefined;
    /** Pending question responses: questionId → resolve function */
    private _pending = new Map<string, (answer: unknown) => void>();

    setWebview(webview: vscode.Webview): void {
        this._webview = webview;
    }

    /** Receives the current turn's abort signal (from ToolCallHandler.setAbortController). */
    setAbortSignal(signal: AbortSignal | undefined): void {
        this._abortSignal = signal;
    }

    /** Called from ChatViewProvider when webview sends a question response. */
    resolveQuestion(questionId: string, answer: unknown): void {
        const resolve = this._pending.get(questionId);
        if (resolve) {
            resolve(answer);
            this._pending.delete(questionId);
        }
    }

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const question = String(args.question || '');
        // Generate a unique ID for this question (declared out here so the
        // finally block can always clean up just THIS question).
        const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        try {
            const optionsRaw = args.options ? args.options : undefined;
            const multiSelect = args.multiSelect === true;

            // Parse options
            let options: Array<{ label: string; description: string }> = [];
            if (optionsRaw) {
                if (typeof optionsRaw === 'string') {
                    try {
                        options = JSON.parse(optionsRaw);
                    } catch {
                        options = [{ label: optionsRaw, description: '' }];
                    }
                } else if (Array.isArray(optionsRaw)) {
                    options = optionsRaw.map((o: unknown) => ({
                        label: String((o as Record<string, unknown>).label ?? o),
                        description: String((o as Record<string, unknown>).description ?? ''),
                    }));
                }
            }

            // Send question to webview for inline rendering
            if (this._webview) {
                this._webview.postMessage({
                    command: 'showQuestion',
                    questionId,
                    question,
                    options,
                    multiSelect: Boolean(multiSelect),
                });
            }

            // If the turn was already aborted before we got here, don't wait.
            if (this._abortSignal?.aborted) {
                this._dismissCard(questionId);
                return this._cancelledResult(question);
            }

            // Wait for the user's answer, or for the turn to be cancelled.
            // No auto-timeout — the model waits for the human, exactly like the
            // approval flow. Cancellation (Stop button / chat switch) resolves
            // the race so the tool doesn't hang forever.
            const CANCELLED = Symbol('cancelled');
            const answer = await new Promise<unknown>(resolve => {
                this._pending.set(questionId, resolve);

                const signal = this._abortSignal;
                if (signal) {
                    const onAbort = () => {
                        // Only resolve-as-cancelled if this question is still pending.
                        if (this._pending.has(questionId)) {
                            this._pending.delete(questionId);
                            resolve(CANCELLED);
                        }
                    };
                    if (signal.aborted) {
                        onAbort();
                    } else {
                        signal.addEventListener('abort', onAbort, { once: true });
                    }
                }
            });

            // Always dismiss the card once we're done waiting (answered or cancelled).
            this._dismissCard(questionId);

            if (answer === CANCELLED) {
                return this._cancelledResult(question);
            }

            return {
                success: true,
                output: JSON.stringify({
                    question,
                    response: answer,
                    cancelled: false,
                }, null, 2),
            };
        } catch (e) {
            // Clean up ONLY this question (not every pending question).
            this._pending.delete(questionId);
            this._dismissCard(questionId);
            return { success: false, output: '', error: (e as Error).message || 'Question failed' };
        }
    }

    /** Tell the webview to remove the question card (answered/cancelled/failed). */
    private _dismissCard(questionId: string): void {
        if (this._webview) {
            this._webview.postMessage({ command: 'removeQuestion', questionId });
        }
    }

    /** Result shape for a question the user never answered (turn cancelled). */
    private _cancelledResult(question: string): ToolResult {
        return {
            success: false,
            output: JSON.stringify({ question, response: null, cancelled: true }, null, 2),
            error: 'The user did not answer this question (the turn was cancelled). Do not assume an answer — ask again if you still need the information.',
        };
    }
}
