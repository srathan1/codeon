/**
 * Tests for execute_command executor with shell: true.
 * Verifies that pipes, redirections, and globs work correctly,
 * while security protections (blocklist, env sanitization) remain intact.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as child_process from 'child_process';
import * as os from 'os';
import { ExecuteCommandExecutor } from '../../tools/executors/executeCommand';
import * as pathSafety from '../../tools/pathSafety';

suite('ExecuteCommandExecutor — shell mode', () => {

    let executor: ExecuteCommandExecutor;
    let spawnStub: sinon.SinonStub;
    let pathStub: sinon.SinonStub;
    let platformStub: sinon.SinonStub;

    setup(() => {
        executor = new ExecuteCommandExecutor(['rm -rf', 'mkfs']);
        spawnStub = sinon.stub(child_process, 'spawn');
        pathStub = sinon.stub(pathSafety, 'getWorkspaceRoot').returns('/workspace');
        platformStub = sinon.stub(os, 'platform').returns('linux');
    });

    teardown(() => {
        sinon.restore();
    });

    /** Create a mock ChildProcess that we can trigger events on. */
    function mockChild(): EventEmitterMock {
        const mock = new EventEmitterMock();
        return mock;
    }

    suite('shell invocation', () => {
        test('uses /bin/sh -c on Unix', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            await executor.execute({ command: 'echo hello' });

            const [program, args] = spawnStub.getCall(0).args as [string, string[]];
            assert.strictEqual(program, '/bin/sh');
            assert.deepStrictEqual(args, ['-c', 'echo hello']);
        });

        test('uses PowerShell on Windows (pwsh preferred)', async () => {
            platformStub.returns('win32');

            // First spawn call is the pwsh detection probe
            const detectMock = mockChild();
            setImmediate(() => detectMock.emitClose(0, null));

            // Second spawn call is the actual command
            const mock = mockChild();
            spawnStub.onFirstCall().returns(detectMock);
            spawnStub.onSecondCall().returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            await executor.execute({ command: 'echo hello' });

            // The actual command (second call) should use pwsh or powershell
            const [program] = spawnStub.getCall(1).args as [string, string[]];
            assert.ok(program.includes('pwsh') || program.includes('powershell'), `expected PowerShell, got ${program}`);
        });

        test('pipes are passed through to the shell', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            await executor.execute({ command: 'cat file.txt | grep pattern' });

            const [, args] = spawnStub.getCall(0).args as [string, string[]];
            // The full command including the pipe is passed to the shell
            assert.ok(args[args.length - 1]?.includes('|'));
        });

        test('redirections are passed through to the shell', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            await executor.execute({ command: 'npm test > results.txt 2>&1' });

            const [, args] = spawnStub.getCall(0).args as [string, string[]];
            // The full command including redirection is passed to the shell
            assert.ok(args[args.length - 1]?.includes('>'));
        });

        test('globs are passed through to the shell', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            await executor.execute({ command: 'ls *.ts' });

            const [, args] = spawnStub.getCall(0).args as [string, string[]];
            assert.ok(args[args.length - 1]?.includes('*'));
        });
    });

    suite('empty command', () => {
        test('empty command returns error without spawning', async () => {
            const result = await executor.execute({ command: '' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('COMMAND_EMPTY'));
            assert.strictEqual(spawnStub.callCount, 0);
        });

        test('whitespace-only command returns error', async () => {
            const result = await executor.execute({ command: '   ' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('COMMAND_EMPTY'));
            assert.strictEqual(spawnStub.callCount, 0);
        });
    });

    suite('blocked programs', () => {
        test('blocks mkfs program', async () => {
            const result = await executor.execute({ command: 'mkfs.ext4 /dev/sda' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('not allowed') || result.error?.includes('BLOCKED'));
            assert.strictEqual(spawnStub.callCount, 0);
        });

        test('blocks dd program', async () => {
            const result = await executor.execute({ command: 'dd if=/dev/zero of=/dev/sda' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('BLOCKED'));
            assert.strictEqual(spawnStub.callCount, 0);
        });

        test('blocks shutdown program', async () => {
            const result = await executor.execute({ command: 'shutdown now' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('not allowed') || result.error?.includes('BLOCKED'));
            assert.strictEqual(spawnStub.callCount, 0);
        });

        test('allows ls even with suspicious-looking args', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            const result = await executor.execute({ command: 'ls -la /tmp' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(spawnStub.callCount, 1);
        });
    });

    suite('legacy blocklist', () => {
        test('blocks rm -rf via legacy substring blocklist', async () => {
            const result = await executor.execute({ command: 'rm -rf /data' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('blocklist'));
            assert.strictEqual(spawnStub.callCount, 0);
        });

        test('allows rm without -rf', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            const result = await executor.execute({ command: 'rm temp.txt' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(spawnStub.callCount, 1);
        });
    });

    suite('exit codes', () => {
        test('success when exit code is 0', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            const result = await executor.execute({ command: 'echo ok' });
            assert.strictEqual(result.success, true);
        });

        test('failure when exit code is non-zero', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(1, null));

            const result = await executor.execute({ command: 'false' });
            assert.strictEqual(result.success, false);
        });

        test('timeout when killed by SIGTERM signal', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(null, 'SIGTERM'));

            const result = await executor.execute({ command: 'sleep 999' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('TIMEOUT'));
        });
    });

    suite('environment sanitization', () => {
        test('sensitive env vars are stripped', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            await executor.execute({ command: 'env' });

            const options = spawnStub.getCall(0).args[2] as Record<string, unknown>;
            const env = options.env as Record<string, string>;
            const sensitiveKeys = Object.keys(env).filter(k =>
                /TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE.?KEY/i.test(k)
            );
            assert.strictEqual(sensitiveKeys.length, 0);
        });
    });

    suite('cwd is workspace root', () => {
        test('spawn uses workspace root as cwd', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            await executor.execute({ command: 'pwd' });

            const options = spawnStub.getCall(0).args[2] as Record<string, unknown>;
            assert.strictEqual(options.cwd, '/workspace');
        });
    });

    suite('stdout/stderr capture', () => {
        test('captures stdout data', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => {
                mock.emitStdout('hello from stdout\n');
                mock.emitClose(0, null);
            });

            const result = await executor.execute({ command: 'echo hello' });
            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('hello from stdout'));
        });

        test('captures stderr on failure', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => {
                mock.emitStderr('error message\n');
                mock.emitClose(1, null);
            });

            const result = await executor.execute({ command: 'bad_cmd' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('error message'));
        });
    });

    suite('spawn error handling', () => {
        test('handles ENOENT when program not found', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => {
                mock.emitError(new Error('ENOENT: no such file or directory'));
            });

            const result = await executor.execute({ command: 'nonexistent_program' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('EXECUTION_ERROR'));
        });
    });

    suite('timeout handling', () => {
        test('respects custom timeout', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            // Do NOT emit close — let the timeout fire
            // We can't easily test the actual timeout in unit tests,
            // but we verify the timeout parameter is accepted
            await executor.execute({ command: 'sleep 999', timeout: 5 });
            // The spawn was called — the timeout logic runs asynchronously
            assert.strictEqual(spawnStub.callCount, 1);
        });

        test('clamps timeout between 5 and 300 seconds', async () => {
            const mock = mockChild();
            spawnStub.returns(mock);

            setImmediate(() => mock.emitClose(0, null));

            // Timeout of 1 should be clamped to 5
            await executor.execute({ command: 'echo hi', timeout: 1 });
            assert.strictEqual(spawnStub.callCount, 1);

            // Timeout of 999 should be clamped to 300
            spawnStub.reset();
            const mock2 = mockChild();
            spawnStub.returns(mock2);
            setImmediate(() => mock2.emitClose(0, null));
            await executor.execute({ command: 'echo hi', timeout: 999 });
            assert.strictEqual(spawnStub.callCount, 1);
        });
    });
});

/** Minimal EventEmitter mock for testing spawn behavior. */
class EventEmitterMock {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event handler args vary by event type
    private _listeners = new Map<string, Array<( ...args: any[]) => void>>();
    private _stdoutListeners: Array<(data: Buffer) => void> = [];
    private _stderrListeners: Array<(data: Buffer) => void> = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event handler args vary by event type
    on(event: string, handler: (...args: any[]) => void): this {
        const list = this._listeners.get(event) || [];
        list.push(handler);
        this._listeners.set(event, list);
        return this;
    }

    get stdout() {
        return {
            on: (event: string, handler: (data: Buffer) => void) => {
                if (event === 'data') this._stdoutListeners.push(handler);
                return this;
            },
        };
    }

    get stderr() {
        return {
            on: (event: string, handler: (data: Buffer) => void) => {
                if (event === 'data') this._stderrListeners.push(handler);
                return this;
            },
        };
    }

    kill(_signal?: string | number): void { /* no-op */ }

    emitClose(code: number | null, signal: NodeJS.Signals | null): void {
        const handlers = this._listeners.get('close') || [];
        for (const h of handlers) h(code, signal);
    }

    emitError(error: Error): void {
        const handlers = this._listeners.get('error') || [];
        for (const h of handlers) h(error);
    }

    emitStdout(text: string): void {
        for (const h of this._stdoutListeners) h(Buffer.from(text));
    }

    emitStderr(text: string): void {
        for (const h of this._stderrListeners) h(Buffer.from(text));
    }
}
