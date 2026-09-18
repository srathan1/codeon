import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SearchFilesExecutor } from '../../tools/executors/searchFiles';
import { GlobFilesExecutor } from '../../tools/executors/globFiles';

/** Point the workspace root at a temp dir for the duration of a test. */
function withWorkspace(dir: string, fn: () => Promise<void>): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: dir } }];
    return fn().finally(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (vscode.workspace as any).workspaceFolders = undefined;
    });
}

suite('search_files (P6-T2/T3/T6)', () => {
    let tmp: string;
    setup(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-'))); });
    teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    test('single file with N matches returns N distinct lines (not duplicate spam)', async () => {
        fs.writeFileSync(path.join(tmp, 'a.txt'), 'foo\nbar foo\nbaz\nfoo end');
        const exec = new SearchFilesExecutor();
        await withWorkspace(tmp, async () => {
            const r = await exec.execute({ path: 'a.txt', pattern: 'foo' });
            assert.strictEqual(r.success, true);
            const lines = r.output.split('\n').filter(Boolean);
            assert.strictEqual(lines.length, 3, `expected 3 matches, got:\n${r.output}`);
            // Distinct line numbers (1, 2, 4), not the same one repeated.
            assert.ok(lines[0].includes('Line 1'));
            assert.ok(lines[1].includes('Line 2'));
            assert.ok(lines[2].includes('Line 4'));
        });
    });

    test('directory search reports all matches across files, not one per file', async () => {
        fs.writeFileSync(path.join(tmp, 'x.txt'), 'hit\nhit');
        fs.writeFileSync(path.join(tmp, 'y.txt'), 'hit');
        const exec = new SearchFilesExecutor();
        await withWorkspace(tmp, async () => {
            const r = await exec.execute({ path: '.', pattern: 'hit' });
            const lines = r.output.split('\n').filter(Boolean);
            assert.strictEqual(lines.length, 3, `expected 3 total matches, got:\n${r.output}`);
        });
    });

    test('filePattern *.ts matches .ts but not .tsx or .ts.bak', async () => {
        fs.writeFileSync(path.join(tmp, 'keep.ts'), 'needle');
        fs.writeFileSync(path.join(tmp, 'skip.tsx'), 'needle');
        fs.writeFileSync(path.join(tmp, 'skip.ts.bak'), 'needle');
        const exec = new SearchFilesExecutor();
        await withWorkspace(tmp, async () => {
            const r = await exec.execute({ path: '.', pattern: 'needle', filePattern: '*.ts' });
            assert.ok(r.output.includes('keep.ts'), 'keep.ts should match');
            assert.ok(!r.output.includes('skip.tsx'), '.tsx must not match *.ts');
            assert.ok(!r.output.includes('skip.ts.bak'), '.ts.bak must not match *.ts');
        });
    });

    test('invalid regex returns a clear error, not a crash', async () => {
        const exec = new SearchFilesExecutor();
        await withWorkspace(tmp, async () => {
            const r = await exec.execute({ path: '.', pattern: '(' });
            assert.strictEqual(r.success, false);
            assert.ok(r.error && r.error.includes('INVALID_REGEX'));
        });
    });
});

suite('glob_files (P6-T7)', () => {
    let tmp: string;
    setup(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glob-'))); });
    teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    test('directory-qualified pattern src/**/*.ts matches nested files', async () => {
        fs.mkdirSync(path.join(tmp, 'src', 'tools'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'src', 'tools', 'foo.ts'), '');
        fs.writeFileSync(path.join(tmp, 'src', 'bar.ts'), '');
        fs.writeFileSync(path.join(tmp, 'top.ts'), '');
        const exec = new GlobFilesExecutor();
        await withWorkspace(tmp, async () => {
            const r = await exec.execute({ patterns: 'src/**/*.ts' });
            const found = JSON.parse(r.output.split('\n... [')[0]) as string[];
            const norm = found.map(f => f.split(path.sep).join('/'));
            assert.ok(norm.includes('src/tools/foo.ts'), `expected src/tools/foo.ts in ${JSON.stringify(norm)}`);
            assert.ok(norm.includes('src/bar.ts'), 'expected src/bar.ts');
            assert.ok(!norm.includes('top.ts'), 'top.ts is outside src/ and must not match');
        });
    });

    test('bare pattern *.ts still matches recursively (basename)', async () => {
        fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'sub', 'deep.ts'), '');
        fs.writeFileSync(path.join(tmp, 'root.ts'), '');
        const exec = new GlobFilesExecutor();
        await withWorkspace(tmp, async () => {
            const r = await exec.execute({ patterns: '*.ts' });
            const found = JSON.parse(r.output.split('\n... [')[0]) as string[];
            const norm = found.map(f => f.split(path.sep).join('/'));
            assert.ok(norm.includes('root.ts') && norm.includes('sub/deep.ts'));
        });
    });
});
