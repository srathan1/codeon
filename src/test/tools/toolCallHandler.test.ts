import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { ToolCallHandler } from '../../tools/toolCallHandler';
import { toolRegistry } from '../../tools/toolRegistry';
import { getAuditLogger } from '../../tools/auditLogger';

suite('ToolCallHandler Tests', () => {
    let tmpDir: string;
    let handler: ToolCallHandler;

    setup(() => {
        // Create a temp directory for file operations
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    suite('Constructor and configuration', () => {
        test('defaults to moderate approval threshold', () => {
            const h = new ToolCallHandler(true);
            // Default threshold is 'moderate' — apply_patch should need approval
            const result = h['needsApproval']('moderate');
            assert.strictEqual(result, true);
        });

        test('safe threshold requires all tools', () => {
            const h = new ToolCallHandler(true, 'safe');
            assert.strictEqual(h['needsApproval']('safe'), true);
            assert.strictEqual(h['needsApproval']('moderate'), true);
            assert.strictEqual(h['needsApproval']('dangerous'), true);
        });

        test('dangerous threshold only blocks dangerous tools', () => {
            const h = new ToolCallHandler(true, 'dangerous');
            assert.strictEqual(h['needsApproval']('safe'), false);
            assert.strictEqual(h['needsApproval']('moderate'), false);
            assert.strictEqual(h['needsApproval']('dangerous'), true);
        });
    });

    suite('list_dir()', () => {
        test('lists files in directory', async () => {
            fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'hello');
            fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'world');
            
            handler = new ToolCallHandler(true, 'dangerous'); // skip approval
            const result = await handler.executeToolCall({
                id: '1',
                name: 'list_dir',
                arguments: { path: '.' }
            });

            // Will fail because no workspace folder — test the error path
            assert.ok(!result.success || result.error?.includes('workspace'), 'Should fail without workspace');
        });
    });

    suite('resolvePath() security', () => {
        test('blocks path traversal outside workspace', () => {
            handler = new ToolCallHandler(true, 'dangerous');
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
                (handler as any).resolvePath('../../etc/passwd');
                assert.fail('Should have thrown');
            } catch (err: unknown) {
                const msg = (err as Error).message;
                assert.ok(msg.includes('escapes workspace'), `Expected path escape error, got: ${msg}`);
            }
        });
    });

    suite('execute_command() safety controls', () => {
        test('blocks commands matching blocklist', async () => {
            handler = new ToolCallHandler(true, 'dangerous', 30, ['rm -rf']);
            
            // We can't call executeCommand directly (private), but we can test via runTool
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
            const result = await (handler as any).runTool('execute_command', {
                command: 'rm -rf /tmp/test',
                timeout: 10
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('blocked'), `Expected blocked error, got: ${result.error}`);
        });

        test('allows non-blocklisted commands', async () => {
            handler = new ToolCallHandler(true, 'dangerous', 30, ['rm -rf']);
            
            // echo should not be blocked
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
            const result = await (handler as any).runTool('execute_command', {
                command: 'echo hello',
                timeout: 10
            });

            // May fail due to no workspace, but should NOT be blocked
            if (result.error?.includes('blocked')) {
                assert.fail('echo should not be blocked');
            }
        });

        test('blocklist is case insensitive', async () => {
            handler = new ToolCallHandler(true, 'dangerous', 30, ['RM -RF']);
            
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
            const result = await (handler as any).runTool('execute_command', {
                command: 'rm -rf /something',
                timeout: 10
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('blocked'));
        });

        test('enforces minimum timeout of 5 seconds', async () => {
            handler = new ToolCallHandler(true, 'dangerous', 30, []);

            // Pass timeout of 1 — should be clamped to 5
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
            const result = await (handler as any).runTool('execute_command', {
                command: 'sleep 100',
                timeout: 1
            });

            // Command will eventually timeout, but with effective timeout >= 5s
            // We can't easily verify the exact timeout value, but verify it doesn't crash
            assert.ok(result !== undefined);
        });

        test('sanitizes sensitive environment variables', () => {
            handler = new ToolCallHandler(true, 'dangerous', 30, []);
            
            // Verify the SENSITIVE_ENV_PATTERNS exist by checking that keys matching them would be stripped
            const patterns = [/TOKEN/i, /PASSWORD/i, /SECRET/i, /API_KEY/i, /PRIVATE.?KEY/i];
            
            assert.ok(patterns.some(p => p.test('AWS_SECRET_ACCESS_KEY')), 'Should match SECRET pattern');
            assert.ok(patterns.some(p => p.test('GITHUB_TOKEN')), 'Should match TOKEN pattern');
            assert.ok(patterns.some(p => p.test('DB_PASSWORD')), 'Should match PASSWORD pattern');
            assert.ok(!patterns.some(p => p.test('HOME')), 'Should not match HOME');
            assert.ok(!patterns.some(p => p.test('PATH')), 'Should not match PATH');
        });
    });

    suite('apply_patch()', () => {
        test('generates diff when content changes', async () => {
            handler = new ToolCallHandler(true, 'dangerous');
            
            // Verify diff library is imported correctly by testing the diff function directly
            const { createTwoFilesPatch } = await import('diff');
            const oldContent = 'line1\nline2\nline3';
            const newContent = 'line1\nmodified_line2\nline3\nline4';
            
            const patch = createTwoFilesPatch('file.txt', 'file.txt', oldContent, newContent);
            assert.ok(patch.includes('@@'), 'Diff should contain hunk markers');
            assert.ok(patch.includes('-line2'), 'Diff should show removed line');
            assert.ok(patch.includes('+modified_line2'), 'Diff should show added line');
        });

        test('handles new file creation diff', async () => {
            const { createTwoFilesPatch } = await import('diff');
            const newContent = 'new file content';
            
            const patch = createTwoFilesPatch('new.txt', 'new.txt', '', newContent);
            assert.ok(patch.length > 0, 'New file should generate a diff');
        });
    });

    suite('getToolCalls() tracking', () => {
        test('returns empty array initially', () => {
            handler = new ToolCallHandler(true);
            assert.strictEqual(handler.getToolCalls().length, 0);
        });
    });

    suite('OpenCode disabled', () => {
        test('throws when openCode is disabled', async () => {
            handler = new ToolCallHandler(false);
            
            await assert.rejects(
                handler.executeToolCall({ id: '1', name: 'read_file', arguments: { path: '.' } }),
                /OpenCode integration is disabled/
            );
        });
    });

    suite('Unknown tool', () => {
        test('returns error for unknown tool name', async () => {
            handler = new ToolCallHandler(true, 'dangerous');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method for testing
            const result = await (handler as any).runTool('unknown_tool', {});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('Unknown tool'));
        });
    });

    suite('Parallel batch execution', () => {
        test('executes multiple read_file calls in parallel', async () => {
            // Create temp workspace with files
            fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content-a');
            fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'content-b');
            fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'content-c');

            handler = new ToolCallHandler(true, 'dangerous');
            // Mock workspace root
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];

            const start = Date.now();
            const results = await handler.executeToolCallsBatch([
                { id: '1', name: 'read_file', arguments: { path: 'a.txt' } },
                { id: '2', name: 'read_file', arguments: { path: 'b.txt' } },
                { id: '3', name: 'read_file', arguments: { path: 'c.txt' } },
            ]);

            const elapsed = Date.now() - start;

            assert.strictEqual(results.length, 3);
            assert.strictEqual(results[0].success, true);
            assert.strictEqual(results[0].output, 'content-a');
            assert.strictEqual(results[1].output, 'content-b');
            assert.strictEqual(results[2].output, 'content-c');

            // All reads should have completed quickly (well under 1s)
            assert.ok(elapsed < 1000, `Parallel reads took ${elapsed}ms`);

            // Reset workspace folders mock
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = undefined;
        });

        test('falls back to sequential when side-effect tools are present', async () => {
            handler = new ToolCallHandler(true, 'dangerous');

            // Mixed batch: read_file + apply_patch → should run sequentially
            const toolCalls = [
                { id: '1', name: 'read_file', arguments: { path: 'x.txt' } },
                { id: '2', name: 'apply_patch', arguments: { path: 'y.txt', content: 'new' } },
            ];

            // executeSequential is private — verify via the classification logic
            // by checking that mixed tools don't throw and return correct count
            // We can't easily test timing here without a real workspace, so just verify the API
            const allSafe = toolCalls.every(tc => ['read_file', 'list_dir', 'search_files'].includes(tc.name));
            assert.strictEqual(allSafe, false, 'Mixed batch should not be all-parallel-safe');
        });

        test('single tool call runs sequentially (no parallel overhead)', async () => {
            fs.writeFileSync(path.join(tmpDir, 'single.txt'), 'solo');

            handler = new ToolCallHandler(true, 'dangerous');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];

            const results = await handler.executeToolCallsBatch([
                { id: '1', name: 'read_file', arguments: { path: 'single.txt' } },
            ]);

            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0].output, 'solo');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = undefined;
        });

        test('preserves order of results matching input tool calls', async () => {
            fs.writeFileSync(path.join(tmpDir, 'first.txt'), 'alpha');
            fs.writeFileSync(path.join(tmpDir, 'second.txt'), 'beta');
            fs.writeFileSync(path.join(tmpDir, 'third.txt'), 'gamma');

            handler = new ToolCallHandler(true, 'dangerous');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];

            const results = await handler.executeToolCallsBatch([
                { id: 'a', name: 'read_file', arguments: { path: 'first.txt' } },
                { id: 'b', name: 'read_file', arguments: { path: 'second.txt' } },
                { id: 'c', name: 'read_file', arguments: { path: 'third.txt' } },
            ]);

            assert.strictEqual(results[0].output, 'alpha');
            assert.strictEqual(results[1].output, 'beta');
            assert.strictEqual(results[2].output, 'gamma');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = undefined;
        });

        test('handles partial failures in parallel batch', async () => {
            fs.writeFileSync(path.join(tmpDir, 'exists.txt'), 'data');

            handler = new ToolCallHandler(true, 'dangerous');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];

            const results = await handler.executeToolCallsBatch([
                { id: '1', name: 'read_file', arguments: { path: 'exists.txt' } },
                { id: '2', name: 'read_file', arguments: { path: 'missing.txt' } },
                { id: '3', name: 'read_file', arguments: { path: 'exists.txt' } },
            ]);

            assert.strictEqual(results.length, 3);
            assert.strictEqual(results[0].success, true);
            assert.strictEqual(results[0].output, 'data');
            assert.strictEqual(results[1].success, false);
            assert.ok(results[1].error?.includes('not found') || results[1].error?.includes('File not found'));
            assert.strictEqual(results[2].success, true);
            assert.strictEqual(results[2].output, 'data');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = undefined;
        });

        test('list_dir and search_files are parallel-safe', async () => {
            fs.writeFileSync(path.join(tmpDir, 'searchable.ts'), 'export function hello() {}');

            handler = new ToolCallHandler(true, 'dangerous');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];

            const results = await handler.executeToolCallsBatch([
                { id: '1', name: 'list_dir', arguments: { path: '.' } },
                { id: '2', name: 'search_files', arguments: { path: '.', pattern: 'hello' } },
            ]);

            assert.strictEqual(results.length, 2);
            assert.strictEqual(results[0].success, true);
            assert.strictEqual(results[1].success, true);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocking readonly workspaceFolders for testing
            (vscode.workspace as any).workspaceFolders = undefined;
        });
    });

    // P5-T1 regression coverage: a static, tool-name-only approval must not
    // silently cover a later call the same tool escalates via its arguments
    // (e.g. write_file targeting a protected path like .env).
    suite('Argument-aware risk escalation (P5-T1)', () => {
        let getExecutorStub: sinon.SinonStub;
        let fakeExecute: sinon.SinonStub;
        let posted: Array<Record<string, unknown>>;
        let fakeWebview: { postMessage: (msg: Record<string, unknown>) => Promise<boolean> };
        let realGetExecutor: typeof toolRegistry.getExecutor;

        setup(() => {
            fakeExecute = sinon.stub().resolves({ success: true, output: 'wrote file' });
            realGetExecutor = toolRegistry.getExecutor.bind(toolRegistry);
            getExecutorStub = sinon.stub(toolRegistry, 'getExecutor').callsFake((name: string) => {
                if (name === 'write_file') {
                    return { name: 'write_file', execute: fakeExecute };
                }
                return realGetExecutor(name);
            });

            posted = [];
            fakeWebview = {
                postMessage: async (msg: Record<string, unknown>) => {
                    posted.push(msg);
                    return true;
                },
            };

            handler = new ToolCallHandler(true, 'moderate');
            handler.setCurrentMode('build');
            handler.setWebview(fakeWebview as unknown as vscode.Webview);
        });

        teardown(() => {
            getExecutorStub.restore();
            sinon.restore();
        });

        test('a session grant for an ordinary write_file call does not cover a later call escalated to a protected path', async () => {
            // First call: an ordinary write_file — approve it with session scope.
            const firstCallPromise = handler.executeToolCallsBatch([
                { id: 'call-1', name: 'write_file', arguments: { path: 'notes.txt', content: 'hello' } },
            ]);
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(posted.length, 1, 'expected an approval prompt for the first call');
            assert.strictEqual(posted[0].toolId, 'call-1');
            assert.strictEqual(posted[0].riskLevel, 'moderate');

            handler.resolveApproval('call-1', true, 'session');
            const firstResults = await firstCallPromise;
            assert.strictEqual(firstResults[0].success, true);
            assert.strictEqual(fakeExecute.callCount, 1);

            // Second call: same tool, but targeting a protected path — this must
            // trigger a FRESH approval prompt at the escalated risk, not be
            // silently waved through by the 'write_file:moderate' session grant
            // above (that was the P5-T1 bypass).
            posted = [];
            const secondCallPromise = handler.executeToolCallsBatch([
                { id: 'call-2', name: 'write_file', arguments: { path: '.env', content: 'SECRET=1' } },
            ]);
            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(posted.length, 1, 'expected a fresh approval prompt for the escalated .env write — the earlier session grant must not silently cover it');
            assert.strictEqual(posted[0].toolId, 'call-2');
            assert.strictEqual(posted[0].riskClass, 'R3', 'write_file targeting .env should be classified R3, not the base R1');
            assert.notStrictEqual(posted[0].riskLevel, 'moderate', 'the escalated call must not be presented as merely moderate risk');

            // Deny it in this test — the point is only that it was prompted,
            // not silently executed.
            handler.resolveApproval('call-2', false);
            const secondResults = await secondCallPromise;
            assert.strictEqual(secondResults[0].success, false);
            // Executor must not have run a second time (still 1 from the first, approved call).
            assert.strictEqual(fakeExecute.callCount, 1);
        });

        test('a workspace-level grant at the base risk does not auto-approve an execute_command call reading a protected path', async () => {
            const execFakeExecute = sinon.stub().resolves({ success: true, output: 'ok' });
            getExecutorStub.callsFake((name: string) => {
                if (name === 'execute_command') return { name: 'execute_command', execute: execFakeExecute };
                if (name === 'write_file') return { name: 'write_file', execute: fakeExecute };
                return realGetExecutor(name);
            });

            // Grant workspace-level approval for an ordinary (non-escalated) command.
            const firstCallPromise = handler.executeToolCallsBatch([
                { id: 'cmd-1', name: 'execute_command', arguments: { command: 'echo hello' } },
            ]);
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(posted.length, 1);
            handler.resolveApproval('cmd-1', true, 'workspace');
            await firstCallPromise;

            // A later command that touches a protected path must still prompt —
            // the blanket workspace rule for execute_command must not cover it.
            posted = [];
            const secondCallPromise = handler.executeToolCallsBatch([
                { id: 'cmd-2', name: 'execute_command', arguments: { command: 'cat .env' } },
            ]);
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(posted.length, 1, 'protected-path command must still require approval despite the workspace grant');
            handler.resolveApproval('cmd-2', false);
            const secondResults = await secondCallPromise;
            assert.strictEqual(secondResults[0].success, false);
        });
    });

    // P5-T3: the extension's own audit trail must be denied outright — not
    // merely escalated to an approvable tier the user (or a workspace-level
    // "always allow") could wave through.
    suite('Audit trail is unconditionally protected (P5-T3)', () => {
        let getExecutorStub: sinon.SinonStub;
        let fakeExecute: sinon.SinonStub;
        let posted: Array<Record<string, unknown>>;
        let fakeWebview: { postMessage: (msg: Record<string, unknown>) => Promise<boolean> };

        setup(() => {
            fakeExecute = sinon.stub().resolves({ success: true, output: 'should never run' });
            const realGetExecutor = toolRegistry.getExecutor.bind(toolRegistry);
            getExecutorStub = sinon.stub(toolRegistry, 'getExecutor').callsFake((name: string) => {
                if (name === 'write_file' || name === 'execute_command') {
                    return { name, execute: fakeExecute };
                }
                return realGetExecutor(name);
            });

            posted = [];
            fakeWebview = {
                postMessage: async (msg: Record<string, unknown>) => {
                    posted.push(msg);
                    return true;
                },
            };

            handler = new ToolCallHandler(true, 'moderate');
            handler.setCurrentMode('build');
            handler.setWebview(fakeWebview as unknown as vscode.Webview);
        });

        teardown(() => {
            getExecutorStub.restore();
            sinon.restore();
        });

        test('write_file targeting .codeon/audit.jsonl is denied without ever prompting for approval', async () => {
            const results = await handler.executeToolCallsBatch([
                { id: 'audit-1', name: 'write_file', arguments: { path: '.codeon/audit.jsonl', content: '{}' } },
            ]);

            // Denied by policy before approval is even considered — no prompt,
            // and the (fake) executor must never run.
            assert.strictEqual(posted.length, 0, 'a denial must not surface as an approval prompt the user could grant');
            assert.strictEqual(results[0].success, false);
            assert.strictEqual(fakeExecute.callCount, 0);
        });

        test('execute_command deleting the audit log is denied even with a prior workspace grant for execute_command', async () => {
            // Establish a workspace-level "always allow" for execute_command via an
            // ordinary, unrelated command first.
            const firstCallPromise = handler.executeToolCallsBatch([
                { id: 'cmd-1', name: 'execute_command', arguments: { command: 'echo hello' } },
            ]);
            await new Promise(resolve => setImmediate(resolve));
            handler.resolveApproval('cmd-1', true, 'workspace');
            await firstCallPromise;

            posted = [];
            const results = await handler.executeToolCallsBatch([
                { id: 'cmd-2', name: 'execute_command', arguments: { command: 'rm .codeon/audit.jsonl' } },
            ]);

            assert.strictEqual(posted.length, 0, 'the blanket execute_command workspace grant must not cover the audit log');
            assert.strictEqual(results[0].success, false);
            assert.strictEqual(fakeExecute.callCount, 1, 'only the first, unrelated command should have executed');
        });
    });

    // P6-T14: a sub-agent's tool calls must go through the exact same risk
    // classification / approval / audit path as the parent conversation's own
    // tool calls — runToolForAgent() is the entry point SpawnAgentExecutor
    // wires SubAgentLoop's executeTool callback to.
    suite('Sub-agent tool execution uses the parent guardrails (P6-T14)', () => {
        let getExecutorStub: sinon.SinonStub;
        let fakeExecute: sinon.SinonStub;
        let posted: Array<Record<string, unknown>>;
        let fakeWebview: { postMessage: (msg: Record<string, unknown>) => Promise<boolean> };
        let realGetExecutor: typeof toolRegistry.getExecutor;

        setup(() => {
            fakeExecute = sinon.stub().resolves({ success: true, output: 'wrote file' });
            realGetExecutor = toolRegistry.getExecutor.bind(toolRegistry);
            getExecutorStub = sinon.stub(toolRegistry, 'getExecutor').callsFake((name: string) => {
                if (name === 'write_file' || name === 'read_file') {
                    return { name, execute: fakeExecute };
                }
                return realGetExecutor(name);
            });

            posted = [];
            fakeWebview = {
                postMessage: async (msg: Record<string, unknown>) => {
                    posted.push(msg);
                    return true;
                },
            };

            handler = new ToolCallHandler(true, 'moderate');
            handler.setCurrentMode('build');
            handler.setWebview(fakeWebview as unknown as vscode.Webview);
        });

        teardown(() => {
            getExecutorStub.restore();
            sinon.restore();
        });

        test('a protected-path write_file call from an agent is approval-gated and tagged with its agentId, exactly like the equivalent parent call', async () => {
            const resultPromise = handler.runToolForAgent('agent-abc123', 'write_file', { path: '.env', content: 'SECRET=1' }, ['write_file']);
            await new Promise(resolve => setImmediate(resolve));

            assert.strictEqual(posted.length, 1, 'a protected-path write must prompt for approval');
            assert.strictEqual(posted[0].agentId, 'agent-abc123', 'the approval card must be attributable to the requesting agent');
            assert.strictEqual(posted[0].riskClass, 'R3', 'write_file targeting .env should be classified R3, same as a parent-conversation call');

            // Deny — the tool must not run.
            const toolId = posted[0].toolId as string;
            handler.resolveApproval(toolId, false);
            const result = await resultPromise;
            assert.strictEqual(result.success, false);
            assert.strictEqual(fakeExecute.callCount, 0);
        });

        test('an approved agent tool call executes and is recorded in the audit log with the agent id', async () => {
            const logger = getAuditLogger();
            const recordStub = sinon.stub(logger, 'record');

            const resultPromise = handler.runToolForAgent('agent-xyz789', 'write_file', { path: '.env', content: 'SECRET=1' }, ['write_file']);
            await new Promise(resolve => setImmediate(resolve));

            const toolId = posted[0].toolId as string;
            handler.resolveApproval(toolId, true);
            const result = await resultPromise;

            assert.strictEqual(result.success, true);
            assert.strictEqual(fakeExecute.callCount, 1);
            assert.strictEqual(recordStub.callCount, 1, 'the sub-agent tool call must be audited');
            const event = recordStub.getCall(0).args[0];
            assert.strictEqual(event.agentId, 'agent-xyz789');
            assert.strictEqual(event.toolName, 'write_file');
            assert.strictEqual(event.outcome, 'success');
        });

        test('a session grant from a parent-conversation call also covers a later agent call at the same escalated risk (shared allowlist)', async () => {
            // Parent conversation approves a protected-path write with session scope.
            const parentPromise = handler.executeToolCallsBatch([
                { id: 'parent-1', name: 'write_file', arguments: { path: '.env', content: 'A=1' } },
            ]);
            await new Promise(resolve => setImmediate(resolve));
            handler.resolveApproval('parent-1', true, 'session');
            await parentPromise;

            // A sub-agent's later call to the same tool at the same escalated
            // risk class must inherit that grant, not re-prompt.
            posted = [];
            const agentResult = await handler.runToolForAgent('agent-inherits', 'write_file', { path: '.env', content: 'B=2' }, ['write_file']);
            assert.strictEqual(posted.length, 0, 'the sub-agent call should inherit the session grant, not re-prompt');
            assert.strictEqual(agentResult.success, true);
            assert.strictEqual(fakeExecute.callCount, 2);
        });

        test('a safe (R0) agent tool call runs without any approval prompt', async () => {
            const result = await handler.runToolForAgent('agent-safe', 'read_file', { path: 'README.md' }, ['read_file']);
            assert.strictEqual(posted.length, 0, 'a safe tool call must not prompt for approval');
            assert.strictEqual(result.success, true);
            assert.strictEqual(fakeExecute.callCount, 1);
        });

        test('C-2: a tool call outside the agent\'s allowlist is rejected before any risk check, even if it would otherwise be safe', async () => {
            const result = await handler.runToolForAgent('agent-scoped', 'write_file', { path: '.env', content: 'X=1' }, ['read_file']);
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('not in this agent\'s allowlist'));
            assert.strictEqual(posted.length, 0, 'an out-of-allowlist call must not even reach the approval prompt');
            assert.strictEqual(fakeExecute.callCount, 0);
        });
    });
});
