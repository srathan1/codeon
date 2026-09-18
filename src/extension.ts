import * as path from 'path';
import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { ApiClient } from './api/apiClient';
import { CodebaseIndexer } from './indexing/codebaseIndexer';
import { RetrievalService } from './indexing/retrievalService';
import { InlineEditProvider } from './edit/inlineEditProvider';
import { AutocompleteProvider } from './edit/autocompleteProvider';
import { ModelManager } from './provider/modelManager';
import { terminalManager } from './tools/terminalManager';
import { getAuditLogger, configureAuditLogger } from './tools/auditLogger';
import { clearAllHandles } from './tools/contentHandle';
import { processManager } from './tools/processManager';

let provider: ChatViewProvider | null = null;
let indexer: CodebaseIndexer | null = null;
let retrievalService: RetrievalService | null = null;
let inlineEditProvider: InlineEditProvider | null = null;
let autocompleteProvider: AutocompleteProvider | null = null;
let indexStatusBarItem: vscode.StatusBarItem | null = null;
let approvalStatusBarItem: vscode.StatusBarItem | null = null;
let autocompleteStatusBarItem: vscode.StatusBarItem | null = null;
let approvalPollInterval: ReturnType<typeof setInterval> | null = null;
let autocompletePollInterval: ReturnType<typeof setInterval> | null = null;

export function activate(context: vscode.ExtensionContext) {
	console.log('Activating CodeOn extension');

	// S-2: must run before any tool call can trigger the first
	// getAuditLogger()/getLogPath() call, so the audit log always lands in
	// global storage rather than falling back to vscode.env.appRoot.
	configureAuditLogger(context.globalStorageUri.fsPath);

	provider = new ChatViewProvider(context.extensionUri, context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('chat-view', provider, { webviewOptions: { retainContextWhenHidden: true } })
	);

	// --- Approval status bar item ---
	approvalStatusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		99
	);
	approvalStatusBarItem.command = 'chat-view.focus';
	context.subscriptions.push(approvalStatusBarItem);

	approvalPollInterval = setInterval(() => {
		const count = provider?.getPendingApprovalCount() ?? 0;
		if (count > 0 && approvalStatusBarItem) {
			approvalStatusBarItem.text = `🔧 ${count} approval${count > 1 ? 's' : ''}`;
			approvalStatusBarItem.tooltip = 'Click to focus chat panel';
			approvalStatusBarItem.show();
		} else if (approvalStatusBarItem) {
			approvalStatusBarItem.hide();
		}
	}, 1000);

	const newChatCommand = vscode.commands.registerCommand('codeon.newChat', () => {
		provider?.clearChat();
		vscode.window.showInformationMessage('New chat started');
	});

	context.subscriptions.push(newChatCommand);

	// Show output channel command
	const showLogsCommand = vscode.commands.registerCommand(
		'codeon.showLogs',
		() => {
			provider?.getObservabilityChannel().show(true);
		}
	);
	context.subscriptions.push(showLogsCommand);

	// Index info command
	const indexInfoCommand = vscode.commands.registerCommand(
		'codeon.indexInfo',
		() => {
			if (!indexer) {
				vscode.window.showInformationMessage('No workspace open — indexer not available');
				return;
			}
			const stats = indexer.getIndexStats();
			const langBreakdown = Object.entries(stats.languages)
				.map(([lang, count]) => `  ${lang}: ${count}`)
				.join('\n');
			vscode.window.showInformationMessage(
				`Index: ${stats.fileCount} files, ${stats.symbolCount} symbols\n${langBreakdown}`,
				{ modal: false }
			);
		}
	);
	context.subscriptions.push(indexInfoCommand);

	// Smoke test command
	const smokeTestCommand = vscode.commands.registerCommand(
		'codeon.runSmokeTests',
		async () => {
			vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Running smoke tests...',
					cancellable: false,
				},
				async (progress) => {
					const { runSmokeTests } = await import('./test/smokeTestRunner');
					await runSmokeTests(progress);
				},
			);
		}
	);
	context.subscriptions.push(smokeTestCommand);

	// Reset conversation command
	const resetConversationCommand = vscode.commands.registerCommand(
		'codeon.resetConversation',
		() => {
			provider?.resetConversation();
		}
	);
	context.subscriptions.push(resetConversationCommand);

	// --- Inline Edit Provider (always available) ---
	inlineEditProvider = InlineEditProvider.getInstance();
	for (const disp of inlineEditProvider.registerCommands()) {
		context.subscriptions.push(disp);
	}
	provider?.setInlineEditProvider(inlineEditProvider);

	// --- Autocomplete Provider ---
	const baseConfig = ApiClient.getConfig();
	const modelMgr = new ModelManager(context, () => {}, () => {});
	const activeModel = modelMgr.getActiveConfig();
	const config = ApiClient.mergeConfig(baseConfig, activeModel);
	if (config.apiKey) {
		autocompleteProvider = new AutocompleteProvider(config);
		context.subscriptions.push(
			vscode.languages.registerInlineCompletionItemProvider({}, autocompleteProvider)
		);

		// Autocomplete acceptance rate status bar (P0-T5)
		autocompleteStatusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			98
		);
		autocompleteStatusBarItem.tooltip = 'Autocomplete acceptance rate';
		context.subscriptions.push(autocompleteStatusBarItem);

		autocompletePollInterval = setInterval(() => {
			if (!autocompleteProvider || !autocompleteStatusBarItem) return;
			const stats = autocompleteProvider.getStats();
			if (stats.requested > 0) {
				autocompleteStatusBarItem.text = `AC: ${Math.round(stats.rate * 100)}%`;
				autocompleteStatusBarItem.show();
			} else {
				autocompleteStatusBarItem.hide();
			}
		}, 2000);

		// Watch for settings changes
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(() => {
				const b = ApiClient.getConfig();
				autocompleteProvider?.updateConfig(ApiClient.mergeConfig(b, modelMgr.getActiveConfig()));
				// Notify chat view of assistant name / other setting changes
				provider?.onSettingsChanged();
			})
		);
	}

	// --- Codebase Indexer ---
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

	// Register rebuild command unconditionally (status bar references it)
	const rebuildIndexCommand = vscode.commands.registerCommand(
		'codeon.rebuildIndex',
		async () => {
			if (!indexer) {
				vscode.window.showWarningMessage('No workspace open — cannot rebuild index');
				return;
			}
			await indexer.rebuildIndex();
			vscode.window.showInformationMessage('Codebase index rebuilt');
		}
	);
	context.subscriptions.push(rebuildIndexCommand);

	if (workspaceRoot) {
		indexer = new CodebaseIndexer(workspaceRoot, context.globalStorageUri.fsPath);

		// Try loading cached index first, then rebuild
		if (!indexer.loadIndex()) {
			indexer.rebuildIndex();
		}

		// Start watching for file changes
		context.subscriptions.push(indexer.startWatching());

		// Status bar item showing index stats
		indexStatusBarItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Right,
			100
		);
		updateStatusBar();
		indexer.onDidChangeIndex(updateStatusBar);
		context.subscriptions.push(indexStatusBarItem);

		// --- Retrieval Service ---
		retrievalService = new RetrievalService(indexer, workspaceRoot);
		provider?.setRetrievalService(retrievalService);

		// Initialize semantic index (runs in background, non-blocking)
		const activeModel = provider?.getModelConfig();
		if (activeModel && activeModel.apiKey) {
			const baseConfig = ApiClient.getConfig();
			const mergedConfig = ApiClient.mergeConfig(baseConfig, activeModel);
			const embedClient = new ApiClient(mergedConfig);
			void retrievalService.initSemanticIndex(embedClient, context.globalStorageUri.fsPath);
		}

		// Track recently opened/edited files for recency boost
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor?.document.uri.fsPath) {
					const rel = path.relative(workspaceRoot, editor.document.uri.fsPath);
					retrievalService?.touchFile(rel);
				}
			})
		);
		context.subscriptions.push(
			vscode.workspace.onDidSaveTextDocument(doc => {
				const rel = path.relative(workspaceRoot, doc.uri.fsPath);
				retrievalService?.touchFile(rel);
			})
		);
	}
}

function updateStatusBar(): void {
	if (!indexStatusBarItem || !indexer) return;
	const stats = indexer.getIndexStats();
	indexStatusBarItem.text = `📁 ${stats.fileCount} files, ${stats.symbolCount} symbols`;
	indexStatusBarItem.tooltip = new vscode.MarkdownString(
		`**Indexed:** ${stats.fileCount} files, ${stats.symbolCount} symbols\n\n` +
		Object.entries(stats.languages)
			.map(([lang, count]) => `${lang}: ${count}`)
			.join('\n')
	);
	indexStatusBarItem.command = 'codeon.rebuildIndex';
	indexStatusBarItem.show();
}

export async function deactivate(): Promise<void> {
	console.log('Deactivating CodeOn extension');
	// Flush pending persistence first (P5-T6) — VS Code awaits a returned
	// promise before finishing deactivation, so this closes the "crash right
	// after deactivate() starts" gap that a fire-and-forget save could miss.
	try {
		await provider?.flushPendingSaves();
	} catch (e) {
		console.warn('[extension] flushPendingSaves failed during deactivate:', e);
	}
	// M-5: dispose the provider itself (observability, listeners, pending temp files).
	provider?.dispose();
	// P-5: two gaps found in the original review — clearAllHandles() was
	// exported but never called anywhere, so the content-handle store leaked
	// across every extension reload; and nothing here ever stopped
	// background processes started via the process-management tools, so a
	// dev server or similar launched mid-session was orphaned on reload.
	clearAllHandles();
	try {
		const running = processManager.list().filter(p => p.status === 'running');
		await Promise.all(running.map(p => processManager.stop(p.id).catch(e =>
			console.warn(`[extension] failed to stop process '${p.id}' during deactivate:`, e)
		)));
	} catch (e) {
		console.warn('[extension] process cleanup failed during deactivate:', e);
	}
	getAuditLogger().dispose();
	autocompleteProvider?.dispose();
	autocompleteProvider = null;
	inlineEditProvider?.dispose();
	inlineEditProvider = null;
	retrievalService?.dispose();
	retrievalService = null;
	indexer?.dispose();
	indexer = null;
	indexStatusBarItem?.dispose();
	indexStatusBarItem = null;
	approvalStatusBarItem?.dispose();
	approvalStatusBarItem = null;
	if (approvalPollInterval) {
		clearInterval(approvalPollInterval);
		approvalPollInterval = null;
	}
	// P6-T5: the autocomplete poll interval was never cleared here, leaking a
	// live 2s timer (and its closure) on every deactivate/reload.
	if (autocompletePollInterval) {
		clearInterval(autocompletePollInterval);
		autocompletePollInterval = null;
	}
	terminalManager.dispose();
	provider = null;
}
