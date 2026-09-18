import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ApplyMultiEditExecutor } from '../../tools/executors/applyMultiEdit';

describe('apply_multi_edit', () => {
    let tmpDir: string;
    let executor: ApplyMultiEditExecutor;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-edit-test-'));
        executor = new ApplyMultiEditExecutor();
    });

    // These tests exercise the argument validation path (no VSCode dependency).
    // Integration tests that actually apply WorkspaceEdit require the extension host.

    describe('argument validation', () => {
        it('rejects missing edits array', async () => {
            const result = await executor.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('INVALID_ARGS'));
        });

        it('rejects non-array edits', async () => {
            const result = await executor.execute({ edits: 'not an array' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('INVALID_ARGS'));
        });

        it('rejects empty edits array', async () => {
            const result = await executor.execute({ edits: [] });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('INVALID_ARGS'));
        });

        it('rejects batch larger than 20 edits', async () => {
            const edits = Array.from({ length: 21 }, (_, i) => ({
                path: `file${i}.txt`,
                mode: 'create',
                newContent: 'hello',
            }));
            const result = await executor.execute({ edits });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('BATCH_TOO_LARGE'));
        });

        it('accepts exactly 20 edits (cap boundary)', async () => {
            // This will fail on protected path or file not found, but should pass the size check
            const edits = Array.from({ length: 20 }, (_, i) => ({
                path: `file${i}.txt`,
                mode: 'create',
                newContent: 'hello',
            }));
            const result = await executor.execute({ edits });
            // Should NOT be BATCH_TOO_LARGE
            assert.ok(!result.error?.includes('BATCH_TOO_LARGE'));
        });

        it('filters out edits with empty path', async () => {
            const result = await executor.execute({ edits: [{ path: '', mode: 'create' }] });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('INVALID_ARGS'));
        });
    });

    describe('mode validation (without VSCode)', () => {
        it('rejects edit mode on non-existent file', async () => {
            const result = await executor.execute({
                edits: [{ path: 'nonexistent.txt', mode: 'edit', oldText: 'x', newText: 'y' }],
            });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('FILE_NOT_FOUND') || result.error?.includes('PROTECTED_PATH'));
        });

        it('rejects delete mode on non-existent file', async () => {
            const result = await executor.execute({
                edits: [{ path: 'nonexistent.txt', mode: 'delete' }],
            });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('FILE_NOT_FOUND') || result.error?.includes('PROTECTED_PATH'));
        });

        it('rejects edit without oldText', async () => {
            const result = await executor.execute({
                edits: [{ path: 'somefile.txt', mode: 'edit', newText: 'replacement' }],
            });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_ARG') || result.error?.includes('FILE_NOT_FOUND'));
        });
    });
});
