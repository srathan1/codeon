import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';

/**
 * Resolve a DebugSession from an optional sessionId argument, or return the active session.
 * Session IDs in VS Code are strings; if a numeric ID is passed it is coerced to string.
 */
function resolveSession(sessionId?: number): vscode.DebugSession {
    const active = vscode.debug.activeDebugSession;
    if (!active) {
        throw new Error('No active debug session. Start debugging first.');
    }
    if (sessionId !== undefined) {
        const targetId = String(sessionId);
        if (active.id !== targetId) {
            throw new Error(`Debug session with id "${targetId}" is not the active session (active: "${active.id}").`);
        }
    }
    return active;
}

/**
 * Return list of active debug sessions.
 * Reports on vscode.debug.activeDebugSession and session metadata.
 */
export class GetDebugSessionsExecutor implements ToolExecutor {
    public name = 'get_debug_sessions';

    public async execute(_args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const active = vscode.debug.activeDebugSession;

            if (!active) {
                return {
                    success: true,
                    output: JSON.stringify({
                        activeSessions: [],
                        total: 0,
                        note: 'No active debug sessions.',
                    }, null, 2),
                };
            }

            const sessions = [{
                id: active.id,
                name: active.name,
                type: active.type,
                configuration: active.configuration,
            }];

            return {
                success: true,
                output: JSON.stringify({
                    activeSessions: sessions,
                    total: sessions.length,
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Get call stack for a debug thread.
 * Uses the Debug Adapter Protocol's "threads" and "stackTrace" requests via
 * session.customRequest() to retrieve threads and their stack frames.
 */
export class GetCallStackExecutor implements ToolExecutor {
    public name = 'get_call_stack';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const sessionId = args.sessionId !== undefined ? Number(args.sessionId) : undefined;
            const threadIdFilter = args.threadId !== undefined ? Number(args.threadId) : undefined;

            const session = resolveSession(sessionId);

            // Request all threads via DAP
            const threadsResponse: unknown = await session.customRequest('threads');
            let threads: Array<{ id: number; name: string }> = (typeof threadsResponse === 'object' && threadsResponse !== null && 'threads' in threadsResponse)
                ? (threadsResponse as Record<string, unknown>).threads as Array<{ id: number; name: string }>
                : [];

            // Filter to specific thread if requested
            if (threadIdFilter !== undefined) {
                threads = threads.filter((t: { id: number; name: string }) => t.id === threadIdFilter);
            }

            if (threads.length === 0) {
                return {
                    success: true,
                    output: JSON.stringify({
                        threads: [],
                        totalThreads: 0,
                        note: threadIdFilter !== undefined
                            ? `No thread found with id ${threadIdFilter}.`
                            : 'No threads in the current debug session.',
                    }, null, 2),
                };
            }

            // Fetch stack trace for each thread
            const resultThreads: Array<{
                threadId: number;
                threadName: string;
                stackFrames: Array<{
                    id: number;
                    name: string;
                    path: string;
                    line: number;
                    column: number;
                }>;
            }> = [];

            for (const thread of threads) {
                const stackResponse: unknown = await session.customRequest('stackTrace', {
                    threadId: thread.id,
                });

                const rawFrames: Array<{
                    id: number;
                    name: string;
                    source?: { path?: string; name?: string };
                    line: number;
                    column: number;
                }> = (typeof stackResponse === 'object' && stackResponse !== null && 'stackFrames' in stackResponse)
                    ? (stackResponse as Record<string, unknown>).stackFrames as Array<{
                        id: number;
                        name: string;
                        source?: { path?: string; name?: string };
                        line: number;
                        column: number;
                    }>
                    : [];

                const frames: Array<{
                    id: number;
                    name: string;
                    path: string;
                    line: number;
                    column: number;
                }> = rawFrames.map((f: {
                    id: number;
                    name: string;
                    source?: { path?: string; name?: string };
                    line: number;
                    column: number;
                }) => ({
                    id: f.id,
                    name: f.name,
                    path: f.source?.path ?? f.source?.name ?? '<unknown>',
                    line: f.line,
                    column: f.column ?? 0,
                }));

                resultThreads.push({
                    threadId: thread.id,
                    threadName: thread.name,
                    stackFrames: frames,
                });
            }

            return {
                success: true,
                output: JSON.stringify({
                    threads: resultThreads,
                    totalThreads: resultThreads.length,
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Get variable scopes for a stack frame in the active debug session.
 * Enumerates all scopes (Locals, Arguments, Closure, etc.) and their variables
 * using DAP "scopes" and "variables" requests.
 */
export class GetDebugScopesExecutor implements ToolExecutor {
    public name = 'get_debug_scopes';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const sessionId = args.sessionId !== undefined ? Number(args.sessionId) : undefined;
            const frameId = args.frameId !== undefined ? Number(args.frameId) : undefined;

            if (frameId === undefined) {
                return {
                    success: false,
                    output: '',
                    error: 'frameId is required. Provide the stack frame ID from get_call_stack.',
                };
            }

            const session = resolveSession(sessionId);

            // Get scopes for this frame via DAP
            const scopesResponse: unknown = await session.customRequest('scopes', {
                frameId,
            });

            const rawScopes: Array<{
                name: string;
                expensive: boolean;
                variablesReference: number;
            }> = (typeof scopesResponse === 'object' && scopesResponse !== null && 'scopes' in scopesResponse)
                ? (scopesResponse as Record<string, unknown>).scopes as Array<{
                    name: string;
                    expensive: boolean;
                    variablesReference: number;
                }>
                : [];

            const resultScopes: Array<{
                name: string;
                expensive: boolean;
                variableCount: number;
                variables: Array<{
                    name: string;
                    value: string;
                    type?: string;
                }>;
            }> = [];

            for (const scope of rawScopes) {
                const varsResponse: unknown = await session.customRequest('variables', {
                    variablesReference: scope.variablesReference,
                });

                const rawVars: Array<{
                    name: string;
                    value: string;
                    type?: string;
                    variablesReference: number;
                }> = (typeof varsResponse === 'object' && varsResponse !== null && 'variables' in varsResponse)
                    ? (varsResponse as Record<string, unknown>).variables as Array<{
                        name: string;
                        value: string;
                        type?: string;
                        variablesReference: number;
                    }>
                    : [];

                const vars: Array<{ name: string; value: string; type?: string }> = rawVars.map((v: {
                    name: string;
                    value: string;
                    type?: string;
                    variablesReference: number;
                }) => ({
                    name: v.name,
                    value: v.value,
                    type: v.type,
                }));

                resultScopes.push({
                    name: scope.name,
                    expensive: scope.expensive,
                    variableCount: vars.length,
                    variables: vars,
                });
            }

            return {
                success: true,
                output: JSON.stringify({
                    frameId,
                    scopes: resultScopes,
                    totalScopes: resultScopes.length,
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Evaluate an expression in the context of the active debug session.
 * Optionally scoped to a specific stack frame.
 */
export class EvaluateDebugExpressionExecutor implements ToolExecutor {
    public name = 'evaluate_debug_expression';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const expression = args.expression ? String(args.expression) : '';
            const sessionId = args.sessionId !== undefined ? Number(args.sessionId) : undefined;
            const frameId = args.frameId !== undefined ? Number(args.frameId) : undefined;

            if (!expression) {
                return {
                    success: false,
                    output: '',
                    error: 'expression is required.',
                };
            }

            const session = resolveSession(sessionId);

            // Build DAP evaluate request arguments
            const dapArgs: Record<string, unknown> = {
                expression,
                context: 'repl',
            };
            if (frameId !== undefined) {
                dapArgs.frameId = frameId;
            }

            const result: Record<string, unknown> = await session.customRequest('evaluate', dapArgs);

            if (!result) {
                return {
                    success: true,
                    output: JSON.stringify({
                        expression,
                        result: undefined,
                        note: 'Evaluation returned no result.',
                    }, null, 2),
                };
            }

            return {
                success: true,
                output: JSON.stringify({
                    expression,
                    result: result.result,
                    variablesReference: result.variablesReference,
                    typedName: result.typedName,
                    presentationHint: result.presentationHint,
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * List breakpoints, optionally filtered by file path.
 */
export class GetBreakpointsExecutor implements ToolExecutor {
    public name = 'get_breakpoints';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const pathFilter = args.path ? String(args.path) : undefined;

            const allBreakpoints = vscode.debug.breakpoints;

            const bpResults: Array<{
                id: string;
                enabled: boolean;
                condition?: string;
                hitCondition?: string;
                logMessage?: string;
                source?: {
                    path?: string;
                    uri: string;
                };
                startLine?: number;
                endLine?: number;
            }> = [];

            for (const bp of allBreakpoints) {
                // Filter by path if requested
                if (pathFilter) {
                    // SourceBreakpoint has a location with uri
                    const sourceUri = (bp as vscode.SourceBreakpoint)?.location?.uri?.fsPath;
                    if (!sourceUri || !sourceUri.endsWith(pathFilter) && !sourceUri.includes(pathFilter)) {
                        continue;
                    }
                }

                const sourceBp = bp as vscode.SourceBreakpoint;
                bpResults.push({
                    id: bp.id,
                    enabled: bp.enabled,
                    condition: bp.condition,
                    hitCondition: bp.hitCondition,
                    logMessage: bp.logMessage,
                    source: sourceBp.location?.uri ? {
                        path: sourceBp.location.uri.fsPath,
                        uri: sourceBp.location.uri.toString(),
                    } : undefined,
                    startLine: sourceBp.location?.range?.start.line !== undefined ? sourceBp.location.range.start.line + 1 : undefined, // 1-indexed
                });
            }

            return {
                success: true,
                output: JSON.stringify({
                    breakpoints: bpResults,
                    total: bpResults.length,
                    filter: pathFilter ?? 'none',
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Start a new debug session using the provided configuration or config name.
 */
export class StartDebuggingExecutor implements ToolExecutor {
    public name = 'start_debugging';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const configArg = args.config ? String(args.config) : undefined;

            // Determine workspace folder (use first available)
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const targetFolder = workspaceFolders?.[0];

            if (!targetFolder) {
                return {
                    success: false,
                    output: '',
                    error: 'No workspace folder open. Open a folder before starting debugging.',
                };
            }

            let configOrName: vscode.DebugConfiguration | string;

            if (configArg) {
                // Try parsing as JSON first
                try {
                    const parsed = JSON.parse(configArg);
                    configOrName = parsed as vscode.DebugConfiguration;
                } catch {
                    // Treat as config name string
                    configOrName = configArg;
                }
            } else {
                // No config provided — use empty config object to let VS Code pick the default
                configOrName = {} as vscode.DebugConfiguration;
            }

            const success = await vscode.debug.startDebugging(targetFolder, configOrName);

            if (success) {
                const active = vscode.debug.activeDebugSession;
                return {
                    success: true,
                    output: JSON.stringify({
                        started: true,
                        session: active ? {
                            id: active.id,
                            name: active.name,
                            type: active.type,
                        } : undefined,
                    }, null, 2),
                };
            } else {
                return {
                    success: false,
                    output: '',
                    error: 'Failed to start debugging. Check launch configurations in .vscode/launch.json.',
                };
            }
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Stop debugging — either a specific session or the active session.
 * Uses DAP "disconnect" request for targeted sessions, or vscode.debug.stopDebugging
 * for stopping the active session.
 */
export class StopDebuggingExecutor implements ToolExecutor {
    public name = 'stop_debugging';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const sessionId = args.sessionId !== undefined ? Number(args.sessionId) : undefined;

            if (sessionId !== undefined) {
                // Disconnect a specific session via DAP
                const session = resolveSession(sessionId);
                await session.customRequest('disconnect', {
                    restart: false,
                });
                return {
                    success: true,
                    output: JSON.stringify({
                        stopped: true,
                        sessionId: session.id,
                        method: 'disconnect',
                    }, null, 2),
                };
            } else {
                // Stop the active debug session via VS Code API
                const active = vscode.debug.activeDebugSession;
                if (!active) {
                    return {
                        success: true,
                        output: JSON.stringify({
                            stopped: false,
                            note: 'No active debug session to stop.',
                        }, null, 2),
                    };
                }
                await vscode.debug.stopDebugging(active);
                return {
                    success: true,
                    output: JSON.stringify({
                        stopped: true,
                        sessionId: active.id,
                        method: 'stopDebugging',
                    }, null, 2),
                };
            }
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
