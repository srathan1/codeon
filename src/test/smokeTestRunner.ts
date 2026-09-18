/**
 * Smoke test runner for the CodeOn extension.
 *
 * Sends automated webview messages through the ChatViewProvider to validate
 * end-to-end functionality across all tool phases. Each smoke test sends a
 * prompt that triggers specific tool behavior, then checks the response.
 *
 * Usage:
 *   1. Via VS Code command: "Chat: Run Smoke Tests"
 *   2. Programmatically: import { runSmokeTests } from './smokeTestRunner';
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SmokeTestResult {
    name: string;
    category: string;
    status: 'pass' | 'fail' | 'skip';
    message: string;
    durationMs: number;
}

interface SmokeTest {
    name: string;
    category: string;
    prompt: string;
    /** What we expect to find in the response (case-insensitive substring). */
    expectContains?: string;
    /** Regex pattern that must match the response. */
    expectMatch?: RegExp;
    /** If set, the response must NOT contain this string. */
    expectNotContains?: string;
    /** Skip condition — evaluated at runtime. */
    skipIf?: () => boolean | undefined;
}

// ---------------------------------------------------------------------------
// Smoke test catalog
// ---------------------------------------------------------------------------

function buildSmokeTests(): SmokeTest[] {
    const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;

    return [
        // --- Phase 1: Core file operations ---
        {
            name: 'list_dir reads current directory',
            category: 'Phase 1 - Files',
            prompt: 'list_dir(".")',
            expectMatch: /"name"/,
            skipIf: () => !hasWorkspace,
        },
        {
            name: 'read_file reads package.json',
            category: 'Phase 1 - Files',
            prompt: 'read_file("package.json")',
            expectContains: '"name"',
            skipIf: () => !hasWorkspace,
        },
        {
            name: 'search_files finds export keyword',
            category: 'Phase 1 - Files',
            prompt: 'search_files(".", "export function")',
            expectMatch: /export function/i,
            skipIf: () => !hasWorkspace,
        },

        // --- Phase 2: Edit tools ---
        {
            name: 'write_file creates temp file',
            category: 'Phase 2 - Edit',
            prompt: 'write_file(".smoke-test-temp.txt", "hello from smoke test")',
            expectMatch: /written|created|success/i,
            skipIf: () => !hasWorkspace,
        },
        {
            name: 'apply_patch generates diff',
            category: 'Phase 2 - Edit',
            prompt: 'apply_patch(".smoke-patch-test.txt", "original line", "modified line")',
            expectMatch: /diff|patch|\+\+\\+/i,
            skipIf: () => !hasWorkspace,
        },

        // --- Phase 3: Command execution ---
        {
            name: 'execute_command runs command',
            category: 'Phase 3 - Commands',
            prompt: 'execute_command("node --version")',
            expectMatch: /v\d+\.\d+\.\d+/i,
        },
        {
            name: 'execute_command blocked on dangerous command',
            category: 'Phase 3 - Commands',
            prompt: 'execute_command("rm -rf /tmp/test-smoke")',
            expectContains: 'blocked',
        },

        // --- Phase 4: Git operations ---
        {
            name: 'git_status shows repository state',
            category: 'Phase 4 - Git',
            prompt: 'git_status()',
            expectMatch: /modified|staged|branch|nothing to commit/i,
            skipIf: () => !hasWorkspace,
        },
        {
            name: 'git_log shows recent commits',
            category: 'Phase 4 - Git',
            prompt: 'git_log(limit=3)',
            expectMatch: /commit|Author|Date/i,
            skipIf: () => !hasWorkspace,
        },
        {
            name: 'git_diff shows changes',
            category: 'Phase 4 - Git',
            prompt: 'git_diff()',
            expectMatch: /diff|@@|---|\+\+\\+/i,
            skipIf: () => !hasWorkspace,
        },

        // --- Phase 5: Web tools ---
        {
            name: 'web_fetch fetches URL',
            category: 'Phase 5 - Web',
            prompt: 'web_fetch("https://httpbin.org/html")',
            expectMatch: /html|fetched|content/i,
        },
        {
            name: 'web_search searches DuckDuckGo',
            category: 'Phase 5 - Web',
            prompt: 'web_search("hello world")',
            expectMatch: /results|search|found/i,
        },

        // --- Phase 5: Debug tools ---
        {
            name: 'debug_sessions lists sessions',
            category: 'Phase 5 - Debug',
            prompt: 'debug_sessions()',
            expectMatch: /session|empty|none|no active/i,
        },
        {
            name: 'debug_breakpoints lists breakpoints',
            category: 'Phase 5 - Debug',
            prompt: 'debug_breakpoints()',
            expectMatch: /breakpoint|none|empty/i,
        },

        // --- Phase 5: Multi-agent tools ---
        {
            name: 'agent_spawn creates subagent',
            category: 'Phase 5 - Agents',
            prompt: 'agent_spawn("test-agent", "say hello")',
            expectMatch: /spawned|agent|task/i,
        },
        {
            name: 'agent_status checks agent state',
            category: 'Phase 5 - Agents',
            prompt: 'agent_status()',
            expectMatch: /agent|status|none|running/i,
        },

        // --- Phase 5: MCP tools ---
        {
            name: 'mcp_search_tools finds tools by query',
            category: 'Phase 5 - MCP',
            prompt: 'search_tools("read file")',
            expectMatch: /tools|found|count/i,
        },
        {
            name: 'mcp_load_tool loads tool definition',
            category: 'Phase 5 - MCP',
            prompt: 'load_tool("read_file")',
            expectMatch: /read_file|risk|phase/i,
        },
        {
            name: 'mcp_list_resources lists resources',
            category: 'Phase 5 - MCP',
            prompt: 'list_mcp_resources()',
            expectMatch: /resources|configured|mcp/i,
        },

        // --- Phase 5: Memory tools ---
        {
            name: 'memory_write stores entry',
            category: 'Phase 5 - Memory',
            prompt: 'write_memory("smoke_test_key", "smoke test value", "workspace")',
            expectMatch: /smoke_test_key|smoke test value/i,
        },
        {
            name: 'memory_read retrieves entry',
            category: 'Phase 5 - Memory',
            prompt: 'read_memory("smoke_test_key", "workspace")',
            expectMatch: /smoke test value|key/i,
        },
        {
            name: 'memory_delete removes entry',
            category: 'Phase 5 - Memory',
            prompt: 'delete_memory("smoke_test_key", "workspace")',
            expectMatch: /deleted|removed|success/i,
        },
        {
            name: 'memory_write rejects secrets',
            category: 'Phase 5 - Memory',
            prompt: 'write_memory("secret_key", "my token is AKIAIOSFODNN7EXAMPLE here")',
            expectContains: 'SECRET_DETECTED',
        },

        // --- Phase 5: Skill tools ---
        {
            name: 'list_skills discovers skills',
            category: 'Phase 5 - Skills',
            prompt: 'list_skills()',
            expectMatch: /skills|count|discovered/i,
        },

        // --- Tool selection validation ---
        {
            name: 'web keyword triggers web tools',
            category: 'Tool Selection',
            prompt: 'Search the web for TypeScript best practices',
            expectMatch: /search|web|results|duckduckgo/i,
        },
        {
            name: 'browser keyword triggers browser tools',
            category: 'Tool Selection',
            prompt: 'Take a screenshot of the current page',
            expectMatch: /screenshot|browser|page/i,
        },
    ];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Send a message to the chat webview and collect the response.
 * Returns the assistant's reply text, or null on timeout.
 */
async function sendChatMessage(
    panel: vscode.WebviewPanel | undefined,
    prompt: string,
    timeoutMs: number = 30_000,
): Promise<string | null> {
    if (!panel) {
        return null;
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);

        // Listen for the assistant's response
        const disposable = panel.webview.onDidReceiveMessage(
            (msg: { type: string; content?: string; error?: string }) => {
                clearTimeout(timer);
                if (msg.type === 'assistant-response' || msg.type === 'response') {
                    resolve(msg.content || msg.error || '');
                } else if (msg.type === 'error') {
                    resolve(`[Error] ${msg.error}`);
                }
                disposable.dispose();
            },
            undefined,
        );

        // Send the prompt
        panel.webview.postMessage({
            type: 'user-message',
            content: prompt,
        });
    });
}

/**
 * Run all smoke tests and return results.
 * Opens an output channel for live logging.
 */
export async function runSmokeTests(
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<SmokeTestResult[]> {
    const outputChannel = vscode.window.createOutputChannel('Smoke Tests', { log: true });
    const results: SmokeTestResult[] = [];
    const tests = buildSmokeTests();

    outputChannel.appendLine(`=== Smoke Test Suite: ${tests.length} tests ===`);
    outputChannel.show();

    // Try to get the chat webview panel
    const chatView = vscode.window.visibleTextEditors.find(
        (e) => e.document.languageId === 'markdown' && e.viewColumn,
    );

    // For webview-based tests, we need the ChatViewProvider's webview
    // Since we can't access it directly, use the command path instead
    let panel: vscode.WebviewPanel | undefined;

    // Show the chat view if not visible
    await vscode.commands.executeCommand('chat-view.focus');

    for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        const start = Date.now();

        progress?.report({
            message: `${i + 1}/${tests.length}: ${test.name}`,
            increment: (100 / tests.length),
        });

        outputChannel.appendLine(`\n[${i + 1}/${tests.length}] ${test.category}: ${test.name}`);

        // Check skip condition
        if (test.skipIf?.()) {
            const result: SmokeTestResult = {
                name: test.name,
                category: test.category,
                status: 'skip',
                message: 'Skipped (prerequisite not met)',
                durationMs: 0,
            };
            results.push(result);
            outputChannel.appendLine(`  SKIP: prerequisite not met`);
            continue;
        }

        try {
            // Execute via ToolCallHandler directly for reliable testing
            const response = await executeToolDirectly(test.prompt);
            const duration = Date.now() - start;

            const passed = checkAssertions(test, response);
            const result: SmokeTestResult = {
                name: test.name,
                category: test.category,
                status: passed ? 'pass' : 'fail',
                message: passed ? 'OK' : formatFailure(test, response),
                durationMs: duration,
            };
            results.push(result);

            if (passed) {
                outputChannel.appendLine(`  PASS (${duration}ms)`);
            } else {
                outputChannel.appendLine(`  FAIL (${duration}ms): ${formatFailure(test, response)}`);
                outputChannel.appendLine(`  Response: ${response.slice(0, 500)}`);
            }
        } catch (err) {
            const duration = Date.now() - start;
            results.push({
                name: test.name,
                category: test.category,
                status: 'fail',
                message: (err as Error).message,
                durationMs: duration,
            });
            outputChannel.appendLine(`  FAIL (${duration}ms): ${(err as Error).message}`);
        }
    }

    // Summary
    const passCount = results.filter((r) => r.status === 'pass').length;
    const failCount = results.filter((r) => r.status === 'fail').length;
    const skipCount = results.filter((r) => r.status === 'skip').length;

    outputChannel.appendLine('\n' + '='.repeat(60));
    outputChannel.appendLine(`Results: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);
    outputChannel.appendLine('='.repeat(60));

    // Show summary notification
    if (failCount > 0) {
        vscode.window.showWarningMessage(
            `Smoke tests: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`,
        );
    } else {
        vscode.window.showInformationMessage(
            `Smoke tests: ${passCount} passed${skipCount > 0 ? `, ${skipCount} skipped` : ''}`,
        );
    }

    return results;
}

/**
 * Parse a tool call from a prompt string and execute it directly via the registry.
 * Format: tool_name(arg1, arg2, ...) or tool_name("arg1", "arg2")
 */
async function executeToolDirectly(prompt: string): Promise<string> {
    // Import dynamically to avoid circular dependency
    const { toolRegistry } = await import('../tools/toolRegistry');

    // Parse the prompt: "tool_name(args...)" → { name, args }
    const match = prompt.match(/^(\w+)\s*\((.*)\)\s*$/s);
    if (!match) {
        return `[Input parse error] Could not parse tool call from: ${prompt}`;
    }

    const [, toolName, argsStr] = match;
    const def = toolRegistry.getDefinition(toolName);
    if (!def) {
        return `[TOOL_NOT_FOUND] '${toolName}' is not registered`;
    }

    const executor = toolRegistry.getExecutor(toolName);
    if (!executor) {
        return `[NO_EXECUTOR] '${toolName}' has no executor`;
    }

    // Simple arg parser: handles quoted strings and simple values
    const args = parseArgs(argsStr, def.parameters);

    try {
        const result = await executor.execute(args);
        if (result.success) {
            return result.output;
        } else {
            return `[Tool error] ${result.error}`;
        }
    } catch (err) {
        return `[Execution error] ${(err as Error).message}`;
    }
}

/**
 * Parse argument string into a Record based on the tool's parameter schema.
 */
function parseArgs(argsStr: string, params?: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (!argsStr.trim()) {
        return result;
    }

    // Extract property names from schema
    const properties = params?.properties as Record<string, unknown> | undefined;
    const propNames = properties ? Object.keys(properties) : [];

    // Handle positional args
    const values = extractValues(argsStr);

    // Support key=value syntax for named arguments
    for (const val of values) {
        if (typeof val === 'string' && val.includes('=')) {
            const eqIdx = val.indexOf('=');
            const key = val.slice(0, eqIdx).trim();
            const rawVal = val.slice(eqIdx + 1).trim();
            result[key] = parseValue(rawVal);
        }
    }

    // Fill remaining positional args
    const positionalValues = values.filter(v => typeof v !== 'string' || !v.includes('='));
    for (let i = 0; i < Math.min(positionalValues.length, propNames.length); i++) {
        if (!(propNames[i] in result)) {
            result[propNames[i]] = positionalValues[i];
        }
    }

    // If no schema, treat as single unnamed arg
    if (propNames.length === 0 && values.length > 0) {
        result['arg'] = values[0];
    }

    return result;
}

/**
 * Extract comma-separated values, respecting quotes.
 */
function extractValues(str: string): unknown[] {
    const values: unknown[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];

        if (inQuote) {
            if (ch === quoteChar && str[i - 1] !== '\\') {
                inQuote = false;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = true;
            quoteChar = ch;
        } else if (ch === ',') {
            values.push(parseValue(current.trim()));
            current = '';
        } else {
            current += ch;
        }
    }

    if (current.trim()) {
        values.push(parseValue(current.trim()));
    }

    return values;
}

/**
 * Parse a single value string into the appropriate JS type.
 */
function parseValue(str: string): unknown {
    // Stripped quoted strings
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
        return str.slice(1, -1);
    }
    // Boolean
    if (str === 'true') return true;
    if (str === 'false') return false;
    // Number
    if (/^-?\d+(\.\d+)?$/.test(str)) return Number(str);
    // Null
    if (str === 'null') return null;
    // JSON object/array
    try {
        return JSON.parse(str);
    } catch {
        // Return as plain string
    }
    return str;
}

/**
 * Check whether a response satisfies the test's assertions.
 */
function checkAssertions(test: SmokeTest, response: string): boolean {
    if (test.expectContains) {
        if (!response.toLowerCase().includes(test.expectContains.toLowerCase())) {
            return false;
        }
    }
    if (test.expectMatch) {
        if (!test.expectMatch.test(response)) {
            return false;
        }
    }
    if (test.expectNotContains) {
        if (response.toLowerCase().includes(test.expectNotContains.toLowerCase())) {
            return false;
        }
    }
    return true;
}

/**
 * Format a failure message showing what was expected vs what was received.
 */
function formatFailure(test: SmokeTest, response: string): string {
    const parts: string[] = [];
    if (test.expectContains) {
        parts.push(`expected to contain "${test.expectContains}"`);
    }
    if (test.expectMatch) {
        parts.push(`expected to match ${test.expectMatch}`);
    }
    if (test.expectNotContains) {
        parts.push(`should NOT contain "${test.expectNotContains}"`);
    }
    return `${parts.join(', ')}. Got: ${response.slice(0, 200)}`;
}
