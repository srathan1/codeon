import * as assert from 'assert';
import * as vscode from 'vscode';
import { InlineEditProvider } from '../../edit/inlineEditProvider';

suite('InlineEditProvider Tests', () => {
    let provider: InlineEditProvider;
    let testUri: vscode.Uri;

    setup(() => {
        // Create a fresh instance for each test
        provider = InlineEditProvider.getInstance();
        testUri = vscode.Uri.file('/tmp/test-file.ts');
    });

    teardown(() => {
        provider.dispose();
    });

    suite('Proposal management', () => {
        test('getInstance returns singleton', () => {
            const p1 = InlineEditProvider.getInstance();
            const p2 = InlineEditProvider.getInstance();
            assert.strictEqual(p1, p2);
        });

        test('hasProposal returns false for unknown file', () => {
            assert.strictEqual(provider.hasProposal('/unknown/file.ts'), false);
        });

        test('getProposals returns empty array initially', () => {
            const proposals = provider.getProposals();
            assert.strictEqual(proposals.length, 0);
        });
    });

    suite('TextDocumentContentProvider', () => {
        test('returns proposal content after setting proposal', async () => {
            const proposedContent = 'console.log("AI proposal");';

            // Set proposal without opening diff editor (diff not testable in unit tests)
            await provider.proposeEdit(testUri, proposedContent, false);

            const proposals = provider.getProposals();
            assert.strictEqual(proposals.length, 1);
            assert.strictEqual(proposals[0].proposedContent, proposedContent);
            assert.strictEqual(proposals[0].originalUri.fsPath, testUri.fsPath);
        });

        test('hasProposal returns true after setting proposal', async () => {
            await provider.proposeEdit(testUri, 'const x = 1;', false);
            assert.strictEqual(provider.hasProposal(testUri.fsPath), true);
        });

        test('multiple proposals stored independently', async () => {
            const uri1 = vscode.Uri.file('/tmp/file1.ts');
            const uri2 = vscode.Uri.file('/tmp/file2.ts');

            await provider.proposeEdit(uri1, 'content1', false);
            await provider.proposeEdit(uri2, 'content2', false);

            assert.strictEqual(provider.getProposals().length, 2);
            assert.strictEqual(provider.hasProposal(uri1.fsPath), true);
            assert.strictEqual(provider.hasProposal(uri2.fsPath), true);
        });
    });

    suite('Proposal cleanup', () => {
        test('dispose clears all proposals', async () => {
            await provider.proposeEdit(testUri, 'some content', false);
            assert.strictEqual(provider.getProposals().length, 1);

            provider.dispose();
            // After dispose, getInstance creates fresh instance
            const fresh = InlineEditProvider.getInstance();
            assert.strictEqual(fresh.getProposals().length, 0);
            fresh.dispose();
        });
    });

    suite('Command registration', () => {
        test('registerCommands returns disposables', () => {
            const disposables = provider.registerCommands();
            assert.ok(Array.isArray(disposables));
            assert.ok(disposables.length > 0);

            // Clean up
            disposables.forEach(d => d.dispose());
        });
    });
});
