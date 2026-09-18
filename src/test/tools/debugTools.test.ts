import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import {
    GetDebugSessionsExecutor,
    GetCallStackExecutor,
    GetDebugScopesExecutor,
    EvaluateDebugExpressionExecutor,
    GetBreakpointsExecutor,
    StartDebuggingExecutor,
    StopDebuggingExecutor,
} from '../../tools/executors/debugTools';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function createMockSession(overrides?: Partial<vscode.DebugSession>): vscode.DebugSession {
    return {
        id: 'mock-session-1',
        name: 'Mock Debug',
        type: 'node',
        configuration: {},
        workspaceFolder: undefined,
        parentSession: undefined,
        targetConfiguration: undefined,
        customRequest: sinon.stub().resolves({}),
        ...overrides,
    } as unknown as vscode.DebugSession;
}

/* ------------------------------------------------------------------ */
/*  Suite                                                             */
/* ------------------------------------------------------------------ */

suite('Debug Tools Executors', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    /* -------------------------------------------------------------- */
    /*  GetDebugSessionsExecutor                                      */
    /* -------------------------------------------------------------- */

    suite('GetDebugSessionsExecutor', () => {
        test('returns empty list when no active debug session', async () => {
            sandbox.stub(vscode.debug, 'activeDebugSession').value(undefined);

            const executor = new GetDebugSessionsExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.deepStrictEqual(parsed.activeSessions, []);
            assert.strictEqual(parsed.total, 0);
            assert.ok(parsed.note.includes('No active debug sessions'));
        });

        test('returns session info when active session exists', async () => {
            const mockSession = createMockSession();
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new GetDebugSessionsExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.total, 1);
            assert.strictEqual(parsed.activeSessions[0].id, 'mock-session-1');
            assert.strictEqual(parsed.activeSessions[0].type, 'node');
        });
    });

    /* -------------------------------------------------------------- */
    /*  GetCallStackExecutor                                          */
    /* -------------------------------------------------------------- */

    suite('GetCallStackExecutor', () => {
        test('returns error when no active debug session', async () => {
            sandbox.stub(vscode.debug, 'activeDebugSession').value(undefined);

            const executor = new GetCallStackExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('No active debug session'));
        });

        test('returns threads and stack frames when session exists', async () => {
            const mockSession = createMockSession({
                customRequest: sinon.stub()
                    .onFirstCall().resolves({
                        threads: [{ id: 1, name: 'main' }],
                    })
                    .onSecondCall().resolves({
                        stackFrames: [
                            {
                                id: 10,
                                name: 'foo',
                                source: { path: '/src/foo.ts' },
                                line: 42,
                                column: 5,
                            },
                        ],
                    }),
            });
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new GetCallStackExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.totalThreads, 1);
            assert.strictEqual(parsed.threads[0].threadId, 1);
            assert.strictEqual(parsed.threads[0].stackFrames.length, 1);
            assert.strictEqual(parsed.threads[0].stackFrames[0].line, 42);
        });

        test('filters to a specific thread by threadId', async () => {
            const mockSession = createMockSession({
                customRequest: sinon.stub()
                    .onFirstCall().resolves({
                        threads: [
                            { id: 1, name: 'main' },
                            { id: 2, name: 'worker' },
                        ],
                    })
                    .onSecondCall().resolves({
                        stackFrames: [
                            {
                                id: 20,
                                name: 'bar',
                                source: { path: '/src/bar.ts' },
                                line: 10,
                                column: 1,
                            },
                        ],
                    }),
            });
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new GetCallStackExecutor();
            const result = await executor.execute({ threadId: 2 });

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.totalThreads, 1);
            assert.strictEqual(parsed.threads[0].threadId, 2);
        });

        test('returns note when filtered thread does not exist', async () => {
            const mockSession = createMockSession({
                customRequest: sinon.stub().resolves({
                    threads: [{ id: 1, name: 'main' }],
                }),
            });
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new GetCallStackExecutor();
            const result = await executor.execute({ threadId: 99 });

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.totalThreads, 0);
            assert.ok(parsed.note?.includes('99'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  GetDebugScopesExecutor                                        */
    /* -------------------------------------------------------------- */

    suite('GetDebugScopesExecutor', () => {
        test('returns error when frameId is missing', async () => {
            const executor = new GetDebugScopesExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('frameId is required'));
        });

        test('returns error when no active debug session', async () => {
            sandbox.stub(vscode.debug, 'activeDebugSession').value(undefined);

            const executor = new GetDebugScopesExecutor();
            const result = await executor.execute({ frameId: 10 });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('No active debug session'));
        });

        test('returns scopes and variables for a valid frameId', async () => {
            const mockSession = createMockSession({
                customRequest: sinon.stub()
                    .onFirstCall().resolves({
                        scopes: [
                            {
                                name: 'Locals',
                                expensive: false,
                                variablesReference: 1,
                            },
                        ],
                    })
                    .onSecondCall().resolves({
                        variables: [
                            { name: 'x', value: '42', type: 'number' },
                            { name: 'y', value: '"hello"', type: 'string' },
                        ],
                    }),
            });
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new GetDebugScopesExecutor();
            const result = await executor.execute({ frameId: 10 });

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.frameId, 10);
            assert.strictEqual(parsed.totalScopes, 1);
            assert.strictEqual(parsed.scopes[0].name, 'Locals');
            assert.strictEqual(parsed.scopes[0].variableCount, 2);
            assert.strictEqual(parsed.scopes[0].variables[0].name, 'x');
        });
    });

    /* -------------------------------------------------------------- */
    /*  EvaluateDebugExpressionExecutor                               */
    /* -------------------------------------------------------------- */

    suite('EvaluateDebugExpressionExecutor', () => {
        test('returns error when expression is missing', async () => {
            const executor = new EvaluateDebugExpressionExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('expression is required'));
        });

        test('returns error when expression is empty string', async () => {
            const executor = new EvaluateDebugExpressionExecutor();
            const result = await executor.execute({ expression: '' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('expression is required'));
        });

        test('returns error when no active debug session', async () => {
            sandbox.stub(vscode.debug, 'activeDebugSession').value(undefined);

            const executor = new EvaluateDebugExpressionExecutor();
            const result = await executor.execute({ expression: 'foo' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('No active debug session'));
        });

        test('evaluates expression and returns result', async () => {
            const mockSession = createMockSession({
                customRequest: sinon.stub().resolves({
                    result: '42',
                    variablesReference: 0,
                    typedName: 'x : number',
                    presentationHint: ['default'],
                }),
            });
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new EvaluateDebugExpressionExecutor();
            const result = await executor.execute({ expression: 'x + y' });

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.expression, 'x + y');
            assert.strictEqual(parsed.result, '42');
            assert.strictEqual(parsed.typedName, 'x : number');
        });

        test('passes frameId in evaluate request when provided', async () => {
            const customRequestStub = sinon.stub().resolves({ result: 'ok' });
            const mockSession = createMockSession({ customRequest: customRequestStub });
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new EvaluateDebugExpressionExecutor();
            await executor.execute({ expression: 'this.value', frameId: 10 });

            // Verify frameId was forwarded to DAP
            const callArgs = customRequestStub.firstCall.args;
            assert.strictEqual(callArgs[0], 'evaluate');
            assert.strictEqual(callArgs[1].frameId, 10);
        });

        test('handles null/undefined evaluate response gracefully', async () => {
            const mockSession = createMockSession({
                customRequest: sinon.stub().resolves(null),
            });
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new EvaluateDebugExpressionExecutor();
            const result = await executor.execute({ expression: 'sideEffect()' });

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.result, undefined);
            assert.ok(parsed.note?.includes('no result'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  GetBreakpointsExecutor                                        */
    /* -------------------------------------------------------------- */

    suite('GetBreakpointsExecutor', () => {
        test('returns empty breakpoint list when none set', async () => {
            sandbox.stub(vscode.debug, 'breakpoints').value([]);

            const executor = new GetBreakpointsExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.deepStrictEqual(parsed.breakpoints, []);
            assert.strictEqual(parsed.total, 0);
            assert.strictEqual(parsed.filter, 'none');
        });

        test('returns breakpoints when some are set', async () => {
            const uri = vscode.Uri.file('/project/src/index.ts');
            const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
            const bp: vscode.SourceBreakpoint = {
                id: 'bp-1',
                enabled: true,
                condition: undefined,
                hitCondition: undefined,
                logMessage: undefined,
                location: { uri, range },
            };
            sandbox.stub(vscode.debug, 'breakpoints').value([bp]);

            const executor = new GetBreakpointsExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.total, 1);
            assert.strictEqual(parsed.breakpoints[0].id, 'bp-1');
            assert.strictEqual(parsed.breakpoints[0].enabled, true);
            assert.strictEqual(parsed.breakpoints[0].startLine, 1); // 1-indexed
        });
    });

    /* -------------------------------------------------------------- */
    /*  StartDebuggingExecutor                                        */
    /* -------------------------------------------------------------- */

    suite('StartDebuggingExecutor', () => {
        test('returns error when no workspace folder is open', async () => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);

            const executor = new StartDebuggingExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('No workspace folder open'));
        });

        test('returns error when workspaceFolders is empty array', async () => {
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([]);

            const executor = new StartDebuggingExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('No workspace folder open'));
        });

        test('returns error when startDebugging fails', async () => {
            const folder = { uri: vscode.Uri.file('/project'), name: 'project', index: 0 };
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([folder]);
            sandbox.stub(vscode.debug, 'startDebugging').resolves(false);

            const executor = new StartDebuggingExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('Failed to start debugging'));
        });

        test('starts debugging successfully with default config', async () => {
            const folder = { uri: vscode.Uri.file('/project'), name: 'project', index: 0 };
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([folder]);
            sandbox.stub(vscode.debug, 'startDebugging').resolves(true);
            sandbox.stub(vscode.debug, 'activeDebugSession').value(createMockSession());

            const executor = new StartDebuggingExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.started, true);
            assert.ok(parsed.session);
        });

        test('parses JSON config argument', async () => {
            const folder = { uri: vscode.Uri.file('/project'), name: 'project', index: 0 };
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([folder]);
            const startStub = sandbox.stub(vscode.debug, 'startDebugging').resolves(true);
            sandbox.stub(vscode.debug, 'activeDebugSession').value(createMockSession());

            const executor = new StartDebuggingExecutor();
            await executor.execute({ config: '{"type":"node","request":"launch"}' });

            // Verify the parsed config was passed
            const configArg = startStub.firstCall.args[1] as vscode.DebugConfiguration;
            assert.strictEqual(configArg.type, 'node');
            assert.strictEqual(configArg.request, 'launch');
        });

        test('uses plain string as config name when not valid JSON', async () => {
            const folder = { uri: vscode.Uri.file('/project'), name: 'project', index: 0 };
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([folder]);
            const startStub = sandbox.stub(vscode.debug, 'startDebugging').resolves(true);
            sandbox.stub(vscode.debug, 'activeDebugSession').value(createMockSession());

            const executor = new StartDebuggingExecutor();
            await executor.execute({ config: 'Launch Program' });

            const configArg = startStub.firstCall.args[1];
            assert.strictEqual(configArg, 'Launch Program');
        });
    });

    /* -------------------------------------------------------------- */
    /*  StopDebuggingExecutor                                         */
    /* -------------------------------------------------------------- */

    suite('StopDebuggingExecutor', () => {
        test('returns "nothing to stop" when no active session', async () => {
            sandbox.stub(vscode.debug, 'activeDebugSession').value(undefined);

            const executor = new StopDebuggingExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.stopped, false);
            assert.ok(parsed.note?.includes('No active debug session to stop'));
        });

        test('calls stopDebugging on active session', async () => {
            const mockSession = createMockSession();
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);
            const stopStub = sandbox.stub(vscode.debug, 'stopDebugging').resolves();

            const executor = new StopDebuggingExecutor();
            const result = await executor.execute({});

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.stopped, true);
            assert.strictEqual(parsed.method, 'stopDebugging');
            assert.ok(stopStub.calledOnce);
        });

        test('disconnects specific session via sessionId', async () => {
            const mockSession = createMockSession({
                customRequest: sinon.stub().resolves({}),
            });
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new StopDebuggingExecutor();
            const result = await executor.execute({ sessionId: 'mock-session-1' });

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.stopped, true);
            assert.strictEqual(parsed.method, 'disconnect');
            assert.strictEqual(parsed.sessionId, 'mock-session-1');

            // Verify disconnect was called on the session
            const customReq = mockSession.customRequest as sinon.SinonStub;
            assert.ok(customReq.calledWith('disconnect'));
        });

        test('returns error when requested sessionId is not active', async () => {
            const mockSession = createMockSession({ id: 'other-session' });
            sandbox.stub(vscode.debug, 'activeDebugSession').value(mockSession);

            const executor = new StopDebuggingExecutor();
            const result = await executor.execute({ sessionId: 'nonexistent' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('not the active session'));
        });
    });
});
