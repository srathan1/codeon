import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ReadMemoryExecutor, WriteMemoryExecutor, DeleteMemoryExecutor } from '../../tools/executors/memoryTools';

suite('Memory Tools Tests', () => {
    let tmpDir: string;
    let memoryDir: string;
    let workspaceStub: vscode.WorkspaceFolder | undefined;
    let workspaceStubbed: sinon.SinonStub;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
        memoryDir = path.join(tmpDir, '.codeon-memory');

        workspaceStub = {
            uri: vscode.Uri.file(tmpDir),
            name: 'test-workspace',
            index: 0,
        } as vscode.WorkspaceFolder;

        workspaceStubbed = sinon.stub(vscode.workspace, 'workspaceFolders').get(() => [workspaceStub]);
    });

    teardown(() => {
        workspaceStubbed.restore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    suite('WriteMemoryExecutor', () => {
        let executor: WriteMemoryExecutor;

        setup(() => {
            executor = new WriteMemoryExecutor();
        });

        test('missing key returns error', async () => {
            const result = await executor.execute({ value: 'hello' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('key') || result.error?.includes('Missing'));
        });

        test('writes a new memory entry', async () => {
            const result = await executor.execute({ key: 'greeting', value: 'Hello world' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.key, 'greeting');
            assert.strictEqual(parsed.value, 'Hello world');
            assert.strictEqual(parsed.scope, 'workspace');
            assert.ok(parsed.createdAt);
            assert.ok(parsed.updatedAt);
        });

        test('persists to disk', async () => {
            await executor.execute({ key: 'persisted', value: 'I am persisted' });
            // Verify file exists on disk
            const userFile = path.join(memoryDir, 'user.json');
            const workspaceFiles = fs.readdirSync(memoryDir).filter(f => f.endsWith('.json'));
            assert.ok(workspaceFiles.length > 0, 'Should have at least one JSON file in .codeon-memory');
        });

        test('updates existing entry and preserves createdAt', async () => {
            const r1 = await executor.execute({ key: 'counter', value: '1' });
            const parsed1 = JSON.parse(r1.output);
            
            // Small delay to ensure updatedAt differs
            await new Promise(r => setTimeout(r, 10));
            
            const r2 = await executor.execute({ key: 'counter', value: '2' });
            const parsed2 = JSON.parse(r2.output);
            
            assert.strictEqual(parsed1.createdAt, parsed2.createdAt, 'createdAt should be preserved');
            assert.ok(parsed2.updatedAt > parsed1.updatedAt, 'updatedAt should increase');
            assert.strictEqual(parsed2.value, '2');
        });

        test('supports user scope', async () => {
            const result = await executor.execute({ key: 'userPref', value: 'dark mode', scope: 'user' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.scope, 'user');
        });

        test('rejects values containing secrets (AWS key pattern)', async () => {
            const result = await executor.execute({ 
                key: 'creds', 
                value: 'aws_secret_access_key=AKIAIOSFODNN7EXAMPLE' 
            });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SECRET'), `Expected secret detection, got: ${result.error}`);
        });

        test('rejects values containing tokens', async () => {
            const result = await executor.execute({ 
                key: 'auth', 
                value: 'GITHUB_TOKEN=ghp_abc123xyz' 
            });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SECRET'));
        });

        test('rejects values containing passwords', async () => {
            const result = await executor.execute({ 
                key: 'db', 
                value: 'DB_PASSWORD=supersecret123' 
            });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SECRET'));
        });

        test('allows normal values without secret patterns', async () => {
            const result = await executor.execute({ 
                key: 'project_notes', 
                value: 'Use TypeScript for all new files, run lint before commit' 
            });
            assert.strictEqual(result.success, true);
        });
    });

    suite('ReadMemoryExecutor', () => {
        let readExec: ReadMemoryExecutor;
        let writeExec: WriteMemoryExecutor;

        setup(() => {
            readExec = new ReadMemoryExecutor();
            writeExec = new WriteMemoryExecutor();
        });

        test('reads previously written entry', async () => {
            await writeExec.execute({ key: 'myKey', value: 'myValue' });
            const result = await readExec.execute({ key: 'myKey' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.key, 'myKey');
            assert.strictEqual(parsed.value, 'myValue');
        });

        test('returns not found for missing key', async () => {
            const result = await readExec.execute({ key: 'nonexistent' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('not found') || result.error?.includes('MEMORY_NOT_FOUND'));
        });

        test('lists all entries when no key provided', async () => {
            await writeExec.execute({ key: 'a', value: 'alpha' });
            await writeExec.execute({ key: 'b', value: 'beta' });
            const result = await readExec.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.count, 2);
            assert.ok(parsed.entries.a);
            assert.ok(parsed.entries.b);
        });

        test('list shows value preview truncated for long values', async () => {
            const longValue = 'x'.repeat(300);
            await writeExec.execute({ key: 'long', value: longValue });
            const result = await readExec.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.ok(parsed.entries.long.value_preview.endsWith('…'), 'Long value should be truncated with ellipsis');
        });

        test('empty list returns count 0', async () => {
            const result = await readExec.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.count, 0);
        });

        test('scope isolation: user vs workspace', async () => {
            await writeExec.execute({ key: 'shared', value: 'user-val', scope: 'user' });
            await writeExec.execute({ key: 'shared', value: 'workspace-val', scope: 'workspace' });

            const userResult = await readExec.execute({ key: 'shared', scope: 'user' });
            const wsResult = await readExec.execute({ key: 'shared', scope: 'workspace' });

            assert.strictEqual(JSON.parse(userResult.output).value, 'user-val');
            assert.strictEqual(JSON.parse(wsResult.output).value, 'workspace-val');
        });
    });

    suite('DeleteMemoryExecutor', () => {
        let deleteExec: DeleteMemoryExecutor;
        let writeExec: WriteMemoryExecutor;

        setup(() => {
            deleteExec = new DeleteMemoryExecutor();
            writeExec = new WriteMemoryExecutor();
        });

        test('missing key returns error', async () => {
            const result = await deleteExec.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('key') || result.error?.includes('Missing'));
        });

        test('deletes existing entry', async () => {
            await writeExec.execute({ key: 'todo', value: 'finish tests' });
            const result = await deleteExec.execute({ key: 'todo' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.deleted, true);
            assert.strictEqual(parsed.key, 'todo');
        });

        test('returns not found for nonexistent key', async () => {
            const result = await deleteExec.execute({ key: 'nope' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('not found') || result.error?.includes('MEMORY_NOT_FOUND'));
        });

        test('deleted entry is no longer readable', async () => {
            const readExec = new ReadMemoryExecutor();
            await writeExec.execute({ key: 'ephemeral', value: 'gone soon' });
            await deleteExec.execute({ key: 'ephemeral' });
            const result = await readExec.execute({ key: 'ephemeral' });
            assert.strictEqual(result.success, false);
        });

        test('respects scope when deleting', async () => {
            await writeExec.execute({ key: 'scoped', value: 'user', scope: 'user' });
            await writeExec.execute({ key: 'scoped', value: 'workspace', scope: 'workspace' });
            
            // Delete from workspace only
            const result = await deleteExec.execute({ key: 'scoped', scope: 'workspace' });
            assert.strictEqual(result.success, true);
            
            // User scope should still exist
            const readExec = new ReadMemoryExecutor();
            const userResult = await readExec.execute({ key: 'scoped', scope: 'user' });
            assert.strictEqual(userResult.success, true);
            assert.strictEqual(JSON.parse(userResult.output).value, 'user');
        });
    });
});
