import * as assert from 'assert';
import { analyzeMessages, formatSummary, StructuredSummary } from '../../context/structuredSummarizer';
import { ChatCompletionMessage } from '../../types';

suite('StructuredSummarizer Tests', () => {
    // ------------------------------------------------------------------
    // analyzeMessages — file paths
    // ------------------------------------------------------------------

    suite('analyzeMessages extracts file paths from tool calls', () => {
        test('extracts file path from write_file tool call', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'call_1',
                            type: 'function',
                            function: {
                                name: 'write_file',
                                arguments: JSON.stringify({ file_path: 'src/foo.ts', content: 'export {}' }),
                            },
                        },
                    ],
                },
            ];

            const summary = analyzeMessages(messages);
            assert.strictEqual(summary.filesModified.length, 1);
            assert.ok(
                summary.filesModified[0].startsWith('src/foo.ts'),
                `Expected path to start with src/foo.ts, got: ${summary.filesModified[0]}`,
            );
        });

        test('extracts file path from edit_file tool call', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'call_2',
                            type: 'function',
                            function: {
                                name: 'edit_file',
                                arguments: JSON.stringify({
                                    file_path: 'src/bar/baz.ts',
                                    old_string: 'const x = 1;\nconst y = 2;',
                                    new_string: 'const x = 10;\nconst y = 20;',
                                }),
                            },
                        },
                    ],
                },
            ];

            const summary = analyzeMessages(messages);
            assert.strictEqual(summary.filesModified.length, 1);
            assert.ok(
                summary.filesModified[0].startsWith('src/bar/baz.ts'),
                `Expected path to start with src/bar/baz.ts, got: ${summary.filesModified[0]}`,
            );
        });

        test('extracts file path from read_file tool call', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'call_3',
                            type: 'function',
                            function: {
                                name: 'read_file',
                                arguments: JSON.stringify({ file_path: 'src/config/settings.json' }),
                            },
                        },
                    ],
                },
            ];

            const summary = analyzeMessages(messages);
            assert.strictEqual(summary.filesRead.length, 1);
            assert.ok(
                summary.filesRead[0].startsWith('src/config/settings.json'),
                `Expected path to start with src/config/settings.json, got: ${summary.filesRead[0]}`,
            );
        });

        test('preserves exact file paths verbatim', () => {
            const path = 'src/deeply/nested/module/index.test.ts';
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'call_4',
                            type: 'function',
                            function: {
                                name: 'write_file',
                                arguments: JSON.stringify({ file_path: path, content: '' }),
                            },
                        },
                    ],
                },
            ];

            const summary = analyzeMessages(messages);
            assert.ok(
                summary.filesModified[0].includes(path),
                `Path should be preserved exactly: ${path}`,
            );
        });
    });

    // ------------------------------------------------------------------
    // analyzeMessages — errors
    // ------------------------------------------------------------------

    suite('analyzeMessages extracts errors from tool results', () => {
        test('extracts error from tool message containing "Error"', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'call_err',
                            type: 'function',
                            function: { name: 'execute_command', arguments: '{"command":"npm test"}' },
                        },
                    ],
                },
                {
                    role: 'tool',
                    content: 'Error: Property \'x\' is missing in type Foo. Fixed by adding x property.',
                    tool_call_id: 'call_err',
                },
            ];

            const summary = analyzeMessages(messages);
            assert.ok(summary.errors.length > 0, 'Should have extracted an error');
            assert.ok(
                summary.errors[0].includes('Property'),
                `Error should contain original text, got: ${summary.errors[0]}`,
            );
        });

        test('extracts error from tool message containing "failed"', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'tool',
                    content: 'Build failed: cannot find module \'./missing\'',
                },
            ];

            const summary = analyzeMessages(messages);
            assert.ok(summary.errors.length > 0, 'Should detect "failed" keyword');
        });

        test('does not extract errors from normal output', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'tool',
                    content: 'All 12 tests passed successfully.',
                },
            ];

            const summary = analyzeMessages(messages);
            assert.strictEqual(summary.errors.length, 0, 'Normal output should not produce errors');
        });
    });

    // ------------------------------------------------------------------
    // analyzeMessages — user intent
    // ------------------------------------------------------------------

    suite('analyzeMessages extracts user intent', () => {
        test('captures first user message as intent', () => {
            const messages: ChatCompletionMessage[] = [
                { role: 'user', content: 'Please refactor the authentication module to use OAuth2.' },
            ];

            const summary = analyzeMessages(messages);
            assert.ok(
                summary.userIntent.includes('refactor'),
                `User intent should capture request, got: ${summary.userIntent}`,
            );
        });

        test('appends subsequent user intents', () => {
            const messages: ChatCompletionMessage[] = [
                { role: 'user', content: 'Fix the login bug.' },
                { role: 'assistant', content: 'Done.' },
                { role: 'user', content: 'Also add unit tests for it.' },
            ];

            const summary = analyzeMessages(messages);
            assert.ok(summary.userIntent.includes('login'));
            assert.ok(summary.userIntent.includes('unit tests'));
        });
    });

    // ------------------------------------------------------------------
    // analyzeMessages — decisions
    // ------------------------------------------------------------------

    suite('analyzeMessages extracts decisions', () => {
        test('extracts decision from assistant message', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: 'After reviewing the options, I decided to use OAuth2 for authentication because it provides better security.',
                },
            ];

            const summary = analyzeMessages(messages);
            assert.ok(summary.decisions.length > 0, 'Should extract a decision');
            assert.ok(
                summary.decisions[0].toLowerCase().includes('oauth2'),
                `Decision should mention OAuth2, got: ${summary.decisions[0]}`,
            );
        });

        test('does not extract decisions from non-decision messages', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: 'I have read the file and made the changes you requested.',
                },
            ];

            const summary = analyzeMessages(messages);
            assert.strictEqual(summary.decisions.length, 0);
        });
    });

    // ------------------------------------------------------------------
    // analyzeMessages — tool results
    // ------------------------------------------------------------------

    suite('analyzeMessages extracts tool results', () => {
        test('extracts command execution result', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'call_cmd',
                            type: 'function',
                            function: {
                                name: 'execute_command',
                                arguments: '{"command":"npm test -- --coverage"}',
                            },
                        },
                    ],
                },
                {
                    role: 'tool',
                    content: '12 passed, 1 failed\nCoverage: 85%',
                    tool_call_id: 'call_cmd',
                },
            ];

            const summary = analyzeMessages(messages);
            assert.ok(
                summary.toolResults.some(t => t.includes('execute_command')),
                `Should track execute_command result, got: ${JSON.stringify(summary.toolResults)}`,
            );
        });
    });

    // ------------------------------------------------------------------
    // analyzeMessages — empty / edge cases
    // ------------------------------------------------------------------

    suite('empty messages produce empty summary', () => {
        test('empty array returns zero-state summary', () => {
            const summary = analyzeMessages([]);
            assert.deepStrictEqual(summary.filesModified, []);
            assert.deepStrictEqual(summary.filesRead, []);
            assert.deepStrictEqual(summary.toolResults, []);
            assert.deepStrictEqual(summary.errors, []);
            assert.deepStrictEqual(summary.decisions, []);
            assert.strictEqual(summary.userIntent, '');
            assert.deepStrictEqual(summary.inProgress, []);
        });

        test('messages with empty content produce minimal summary', () => {
            const messages: ChatCompletionMessage[] = [
                { role: 'user', content: '' },
                { role: 'assistant', content: '' },
            ];

            const summary = analyzeMessages(messages);
            assert.strictEqual(summary.userIntent, '');
            assert.deepStrictEqual(summary.decisions, []);
        });
    });

    // ------------------------------------------------------------------
    // formatSummary
    // ------------------------------------------------------------------

    suite('formatSummary produces correct markdown', () => {
        test('renders all sections when populated', () => {
            const summary: StructuredSummary = {
                userIntent: 'Refactor auth module',
                filesModified: ['src/auth.ts: Changed X to Y'],
                filesRead: ['src/types.ts: Found AuthInterface'],
                toolResults: ['execute_command("npm test"): 12 passed'],
                errors: ['"TypeError: undefined": fixed by adding null check'],
                decisions: ['Decided to use OAuth2 for authentication'],
                inProgress: ['Implementing token refresh logic'],
                constraints: ['Must maintain backward compatibility'],
                remainingWork: ['Write integration tests'],
                nextAction: 'Run the test suite to verify changes',
            };

            const md = formatSummary(summary);

            assert.ok(md.includes('## Conversation Summary'));
            assert.ok(md.includes('### User Intent'));
            assert.ok(md.includes('### Files Modified'));
            assert.ok(md.includes('### Files Read'));
            assert.ok(md.includes('### Tool Results'));
            assert.ok(md.includes('### Errors Encountered'));
            assert.ok(md.includes('### Architecture Decisions'));
            assert.ok(md.includes('### Current State'));

            assert.ok(md.includes('Refactor auth module'));
            assert.ok(md.includes('- src/auth.ts: Changed X to Y'));
            assert.ok(md.includes('- src/types.ts: Found AuthInterface'));
            assert.ok(md.includes('- execute_command("npm test"): 12 passed'));
            assert.ok(md.includes('"TypeError: undefined": fixed by adding null check'));
            assert.ok(md.includes('- Decided to use OAuth2 for authentication'));
            assert.ok(md.includes('- Implementing token refresh logic'));
        });

        test('omits empty sections', () => {
            const summary: StructuredSummary = {
                userIntent: '',
                filesModified: [],
                filesRead: [],
                toolResults: [],
                errors: [],
                decisions: [],
                inProgress: [],
                constraints: [],
                remainingWork: [],
                nextAction: '',
            };

            const md = formatSummary(summary);
            assert.ok(md.includes('## Conversation Summary'));
            assert.ok(!md.includes('### Files Modified'));
            assert.ok(!md.includes('### Files Read'));
            assert.ok(!md.includes('### Errors Encountered'));
        });

        test('uses bullet points for list items', () => {
            const summary: StructuredSummary = {
                userIntent: '',
                filesModified: ['a.ts: change 1', 'b.ts: change 2'],
                filesRead: [],
                toolResults: [],
                errors: [],
                decisions: [],
                inProgress: [],
                constraints: [],
                remainingWork: [],
                nextAction: '',
            };

            const md = formatSummary(summary);
            assert.ok(md.includes('- a.ts: change 1'));
            assert.ok(md.includes('- b.ts: change 2'));
        });
    });

    // ------------------------------------------------------------------
    // analyzeMessages — in progress
    // ------------------------------------------------------------------

    suite('analyzeMessages extracts in-progress items', () => {
        test('extracts "next I\'ll" pattern', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: "The refactoring is done. Next I'll add the unit tests for the new module.",
                },
            ];

            const summary = analyzeMessages(messages);
            assert.ok(summary.inProgress.length > 0, 'Should extract in-progress item');
            assert.ok(
                summary.inProgress[0].toLowerCase().includes('unit test'),
                `Expected unit test mention, got: ${summary.inProgress[0]}`,
            );
        });

        test('no in-progress for non-final messages', () => {
            const messages: ChatCompletionMessage[] = [
                {
                    role: 'assistant',
                    content: "Next I'll do something.",
                },
                {
                    role: 'user',
                    content: 'Actually, never mind.',
                },
            ];

            const summary = analyzeMessages(messages);
            assert.strictEqual(summary.inProgress.length, 0, 'Only last assistant message should set in-progress');
        });
    });
});
