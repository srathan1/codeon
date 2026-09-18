import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { StatPathExecutor } from '../../tools/executors/statPath';

/** Point the workspace root at a temp dir for the duration of a test. */
function withWorkspace(dir: string, fn: () => Promise<void>): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: dir } }];
    return fn().finally(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.workspace as any).workspaceFolders = undefined;
    });
}

suite('stat_path lineCount', () => {
    let tmp: string;
    const executor = new StatPathExecutor();

    setup(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'statpath-'))); });
    teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    test('reports lineCount for a small text file, without the caller having to read_file', async () => {
        await withWorkspace(tmp, async () => {
            fs.writeFileSync(path.join(tmp, 'sample.ts'), 'line one\nline two\nline three\n');
            const result = await executor.execute({ path: 'sample.ts' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            // 'a\nb\nc\n'.split('\n') -> ['a','b','c',''] == 4, matching how a
            // trailing-newline text file is conventionally counted.
            assert.strictEqual(parsed.lineCount, 4);
            assert.strictEqual(parsed.binary, false);
        });
    });

    test('lineCount matches a plain split("\\n").length count for varied content', async () => {
        await withWorkspace(tmp, async () => {
            const content = Array.from({ length: 50 }, (_, i) => `const x${i} = ${i};`).join('\n');
            fs.writeFileSync(path.join(tmp, 'many-lines.ts'), content);
            const result = await executor.execute({ path: 'many-lines.ts' });
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.lineCount, content.split('\n').length);
            assert.strictEqual(parsed.lineCount, 50);
        });
    });

    test('does not report lineCount for files at/over the 1MB content-read threshold', async () => {
        await withWorkspace(tmp, async () => {
            const big = 'x'.repeat(1_000_001);
            fs.writeFileSync(path.join(tmp, 'huge.txt'), big);
            const result = await executor.execute({ path: 'huge.txt' });
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.lineCount, undefined);
        });
    });

    test('MISSING_ARGUMENT when neither path nor paths is provided', async () => {
        const result = await executor.execute({});
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('MISSING_ARGUMENT'));
    });
});

suite('stat_path batch (paths[])', () => {
    let tmp: string;
    const executor = new StatPathExecutor();

    setup(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'statpath-batch-'))); });
    teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    test('returns one result per path, in order, in a single call', async () => {
        await withWorkspace(tmp, async () => {
            fs.writeFileSync(path.join(tmp, 'a.ts'), 'x\ny\n');
            fs.writeFileSync(path.join(tmp, 'b.ts'), 'x\ny\nz\n');
            fs.writeFileSync(path.join(tmp, 'c.ts'), 'x\n');

            const result = await executor.execute({ paths: ['a.ts', 'b.ts', 'c.ts'] });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.length, 3);
            assert.strictEqual(parsed[0].path, 'a.ts');
            assert.strictEqual(parsed[0].lineCount, 3);
            assert.strictEqual(parsed[1].path, 'b.ts');
            assert.strictEqual(parsed[1].lineCount, 4);
            assert.strictEqual(parsed[2].path, 'c.ts');
            assert.strictEqual(parsed[2].lineCount, 2);
        });
    });

    test('a bad path in the batch is reported per-entry, not a whole-call failure', async () => {
        await withWorkspace(tmp, async () => {
            fs.writeFileSync(path.join(tmp, 'good.ts'), 'x\ny\n');

            const result = await executor.execute({ paths: ['good.ts', 'does-not-exist.ts'] });
            assert.strictEqual(result.success, true, 'one missing file should not fail the whole batch');
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.length, 2);
            assert.strictEqual(parsed[0].lineCount, 3);
            assert.strictEqual(parsed[1].exists, false);
        });
    });

    test('rejects an empty paths array', async () => {
        const result = await executor.execute({ paths: [] });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('EMPTY_PATH_LIST'));
    });

    test('rejects a batch over the size limit', async () => {
        const tooMany = Array.from({ length: 501 }, (_, i) => `file${i}.ts`);
        const result = await executor.execute({ paths: tooMany });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('TOO_MANY_PATHS'));
    });
});
