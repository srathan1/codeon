import * as path from 'path';
import * as vscode from 'vscode';

/** Custom URI scheme for AI-proposed file content. */
const AI_PROPOSAL_SCHEME = 'codeon-proposal';

/**
 * Stores a proposed edit: original URI + proposed content.
 * The TextDocumentContentProvider serves the proposed content
 * so `vscode.diff` can show side-by-side comparison.
 */
export interface ProposedEdit {
    originalUri: vscode.Uri;
    proposedContent: string;
}

/**
 * Manages inline edit previews using VS Code's diff editor.
 *
 * Flow:
 * 1. Model proposes a code change (file path + new content)
 * 2. We store the proposal in a Map keyed by file path
 * 3. Open `vscode.diff` showing original vs AI proposal
 * 4. User accepts → apply via WorkspaceEdit, or rejects → discard
 */
export class InlineEditProvider {
    private static instance: InlineEditProvider | null = null;

    /** Registered content provider for virtual proposal documents. */
    private contentProvider: vscode.Disposable;

    /** Active proposals: key = fsPath, value = proposed content. */
    private proposals = new Map<string, ProposedEdit>();

    /** Currently open diff editor panels (for cleanup). */
    private diffPanels: vscode.TextEditor[] = [];

    private constructor() {
        const emitter = new vscode.EventEmitter<vscode.Uri>();
        this.contentProvider = vscode.workspace.registerTextDocumentContentProvider(
            AI_PROPOSAL_SCHEME,
            {
                onDidChange: emitter.event,
                provideTextDocumentContent(uri): string {
                    // URI format: codeon-proposal://file/<absolute-path>
                    const fsPath = uri.path.slice(1); // strip leading /
                    const proposal = InlineEditProvider.instance?.proposals.get(fsPath);
                    return proposal?.proposedContent ?? '';
                },
            }
        );
    }

    public static getInstance(): InlineEditProvider {
        if (!InlineEditProvider.instance) {
            InlineEditProvider.instance = new InlineEditProvider();
        }
        return InlineEditProvider.instance;
    }

    /**
     * Register the accept/reject commands.
     * Returns disposables to add to context.subscriptions.
     */
    registerCommands(): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];

        disposables.push(
            vscode.commands.registerCommand('codeon.acceptDiff', async () => {
                await this.acceptCurrentDiff();
            })
        );

        disposables.push(
            vscode.commands.registerCommand('codeon.rejectDiff', async () => {
                await this.rejectCurrentDiff();
            })
        );

        disposables.push(
            vscode.commands.registerCommand('codeon.editWithSelection', async () => {
                await this.triggerEditWithSelection();
            })
        );

        return disposables;
    }

    /**
     * Submit a proposed edit and optionally open the diff viewer.
     * @param originalUri  The original file URI.
     * @param proposedContent  The AI-generated replacement content.
     * @param openDiff  If true (default), opens side-by-side diff editor.
     */
    public async proposeEdit(
        originalUri: vscode.Uri,
        proposedContent: string,
        openDiff: boolean = true
    ): Promise<void> {
        const fsPath = originalUri.fsPath;
        this.proposals.set(fsPath, { originalUri, proposedContent });

        if (openDiff) {
            // Build the virtual URI for the proposed version
            const proposalUri = vscode.Uri.parse(`${AI_PROPOSAL_SCHEME}:/${fsPath}`);

            const fileName = path.basename(originalUri.fsPath);
            await vscode.commands.executeCommand(
                'vscode.diff',
                originalUri,
                proposalUri,
                `${fileName}: Original ↔ AI Proposal`
            );

            // Track the diff panel
            const editors = vscode.window.visibleTextEditors.filter(
                e => e.document.uri.scheme === AI_PROPOSAL_SCHEME
            );
            this.diffPanels.push(...editors);
        }
    }

    /**
     * Accept the currently visible diff: apply proposed content to the original file.
     */
    public async acceptCurrentDiff(): Promise<void> {
        // Find the active editor — if it's a proposal document, get its original
        const active = vscode.window.activeTextEditor;
        if (!active) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        let proposal: ProposedEdit | undefined;

        if (active.document.uri.scheme === AI_PROPOSAL_SCHEME) {
            // User is looking at the proposal side of the diff
            const fsPath = active.document.uri.path.slice(1);
            proposal = this.proposals.get(fsPath);
        } else {
            // Try to find a proposal matching the current file
            proposal = this.proposals.get(active.document.uri.fsPath);
        }

        if (!proposal) {
            vscode.window.showWarningMessage('No pending edit to accept');
            return;
        }

        // Apply the edit
        const edit = new vscode.WorkspaceEdit();
        const doc = await vscode.workspace.openTextDocument(proposal.originalUri);
        const fullRange = new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length)
        );
        edit.replace(proposal.originalUri, fullRange, '');
        edit.insert(proposal.originalUri, doc.positionAt(0), proposal.proposedContent);

        const success = await vscode.workspace.applyEdit(edit);
        if (success) {
            // Save the file
            await vscode.workspace.fs.writeFile(proposal.originalUri, Buffer.from(proposal.proposedContent));
            vscode.window.showInformationMessage('Changes applied');
        } else {
            vscode.window.showErrorMessage('Failed to apply changes');
        }

        // Clean up
        this.clearProposal(proposal.originalUri.fsPath);
    }

    /**
     * Reject the currently visible diff: discard the proposal.
     */
    public async rejectCurrentDiff(): Promise<void> {
        const active = vscode.window.activeTextEditor;
        if (!active) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }

        let fsPath: string;
        if (active.document.uri.scheme === AI_PROPOSAL_SCHEME) {
            fsPath = active.document.uri.path.slice(1);
        } else {
            fsPath = active.document.uri.fsPath;
        }

        this.clearProposal(fsPath);
        vscode.window.showInformationMessage('Changes discarded');
    }

    /**
     * Trigger "Edit with Selection" — sends selected code to chat.
     * The webview handles sending the message with the selection context.
     */
    public async triggerEditWithSelection(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Open a file first');
            return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
            vscode.window.showWarningMessage('Select code to edit');
            return;
        }

        const selectedText = editor.document.getText(selection);
        const filePath = editor.document.uri.fsPath;
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;

        // Signal the webview to enter edit mode with this selection
        // The ChatViewProvider listens for this and pre-fills the input
        vscode.commands.executeCommand('codeon.setEditMode', {
            filePath,
            startLine,
            endLine,
            selectedText,
        });
    }

    /** Get all active proposals. */
    getProposals(): ProposedEdit[] {
        return [...this.proposals.values()];
    }

    /** Check if a file has a pending proposal. */
    hasProposal(fsPath: string): boolean {
        return this.proposals.has(fsPath);
    }

    /** Clear a specific proposal. */
    private clearProposal(fsPath: string): void {
        this.proposals.delete(fsPath);
    }

    /** Clear all proposals and dispose resources. */
    public dispose(): void {
        this.proposals.clear();
        this.contentProvider.dispose();
        this.diffPanels = [];
        InlineEditProvider.instance = null;
    }
}
