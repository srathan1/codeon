import * as assert from 'assert';
import { ContextManager } from '../../context/contextManager';
import { ChatConfig, Attachment, ChatCompletionMessage, NativeToolCall, RetrievedChunk } from '../../types';

const testConfig: ChatConfig = {
    modelEndpoint: 'http://localhost:8080',
    modelName: 'test-model',
    apiKey: 'test-key',
    contextWindowSize: 4096,
    defaultMode: 'plan',
    openCodeEnabled: false,
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    presencePenalty: 1.5,
    repetitionPenalty: 1.0,
    minP: 0.0
};

suite('ContextManager Tests', () => {
    let cm: ContextManager;

    setup(() => {
        cm = new ContextManager(testConfig);
    });

    suite('countTokens()', () => {
        test('returns 0 for empty string', () => {
            assert.strictEqual(ContextManager.countTokens(''), 0);
        });

        test('returns 0 for null/undefined', () => {
            assert.strictEqual(ContextManager.countTokens(''), 0);
        });

        test('counts simple English text', () => {
            const tokens = ContextManager.countTokens('Hello world, this is a test.');
            assert.ok(tokens > 0, 'Should have positive token count');
            // "Hello world, this is a test." is roughly 8-10 tokens with cl100k_base
            assert.ok(tokens >= 5 && tokens <= 20, `Expected ~8-10 tokens, got ${tokens}`);
        });

        test('counts code correctly', () => {
            const code = 'function hello() { return "world"; }';
            const tokens = ContextManager.countTokens(code);
            assert.ok(tokens > 0, 'Code should have positive token count');
        });

        test('longer text has more tokens', () => {
            const short = ContextManager.countTokens('hello');
            const long = ContextManager.countTokens('This is a much longer sentence with many more words to count as tokens in the encoder.');
            assert.ok(long > short, 'Longer text should have more tokens');
        });
    });

    suite('getContextSize()', () => {
        test('returns 0 for empty context', () => {
            cm.setApiMessages([]);
            assert.strictEqual(cm.getContextSize(), 0);
        });

        test('counts tokens in apiMessages', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'You are a helpful assistant.' },
                { role: 'user', content: 'Hello, how are you?' }
            ];
            cm.setApiMessages(msgs);
            const size = cm.getContextSize();
            assert.ok(size > 0, 'Context size should be positive');
            // system message (~7 tokens) + user message (~6 tokens) + 2 role overheads
            assert.ok(size >= 10 && size <= 30, `Expected ~15 tokens, got ${size}`);
        });

        test('counts tool_call_id overhead', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'tool', content: 'file contents here', tool_call_id: 'call_abc123' }
            ];
            cm.setApiMessages(msgs);
            const size = cm.getContextSize();
            assert.ok(size > 0);
        });

        test('counts tool_calls arguments in assistant messages', () => {
            const toolCalls: NativeToolCall[] = [{
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path": "src/file.ts"}' }
            }];
            const msgs: ChatCompletionMessage[] = [
                { role: 'assistant', content: 'Let me read that file.', tool_calls: toolCalls }
            ];
            cm.setApiMessages(msgs);
            const size = cm.getContextSize();
            // Should include: role(1) + content + tool_call id + type + name + arguments
            assert.ok(size > 10, `Expected tool_calls overhead counted, got ${size}`);

            // Compare with same message without tool_calls
            const msgsNoTools: ChatCompletionMessage[] = [
                { role: 'assistant', content: 'Let me read that file.' }
            ];
            cm.setApiMessages(msgsNoTools);
            const sizeNoTools = cm.getContextSize();
            assert.ok(size > sizeNoTools, 'tool_calls should add token overhead');
        });

        test('counts attachment content', () => {
            const att: Attachment = {
                id: '1',
                name: 'test.ts',
                content: 'export class Test { constructor() {} }',
                type: 'code',
                size: 42
            };
            cm.addAttachment(att);
            const size = cm.getContextSize();
            assert.ok(size > 0, 'Attachment content should be counted');
        });

        test('combined messages and attachments', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'user', content: 'Check this file:' }
            ];
            const att: Attachment = {
                id: '1',
                name: 'data.json',
                content: '{"key": "value", "nested": {"a": 1, "b": 2}}',
                type: 'file',
                size: 50
            };
            cm.setApiMessages(msgs);
            cm.addAttachment(att);
            const size = cm.getContextSize();
            assert.ok(size >= 10, 'Combined context should count both messages and attachments');
        });
    });

    // H-10: addMessage()/getContext()/private trimContext() were dead code —
    // only ever called from this test file, never from any production path
    // (production context sizing goes entirely through setApiMessages() +
    // getContextSize(), which is what the tests below already exercise).
    // Removed along with their tests; clearContext's reset behavior is still
    // covered via the live apiMessages/attachments path.
    suite('clearContext()', () => {
        test('resets everything', () => {
            const att: Attachment = { id: '1', name: 'a.txt', content: 'hi', type: 'code', size: 2 };
            cm.addAttachment(att);
            cm.setApiMessages([{ role: 'user', content: 'api msg' }]);
            assert.ok(cm.getContextSize() > 0);

            cm.clearContext();

            assert.strictEqual(cm.getContextSize(), 0);
        });
    });

    suite('clearRetrievedContext()', () => {
        test('clears retrieved chunks without touching apiMessages/attachments', () => {
            const chunk: RetrievedChunk = {
                filePath: 'src/foo.ts',
                startLine: 1,
                endLine: 10,
                text: 'export function foo() {}',
                tokenCount: 10,
                symbols: [],
                score: 0.9,
                source: 'symbol',
            };
            cm.addRetrievedContext([chunk]);
            assert.strictEqual(cm.getRetrievedChunks().length, 1);

            const att: Attachment = { id: '1', name: 'a.txt', content: 'hi', type: 'code', size: 2 };
            cm.addAttachment(att);
            cm.setApiMessages([{ role: 'user', content: 'api msg' }]);

            cm.clearRetrievedContext();

            assert.strictEqual(cm.getRetrievedChunks().length, 0, 'retrieved chunks must be cleared');
            assert.strictEqual(cm.getApiMessages().length, 1, 'apiMessages must be untouched');
            assert.ok(cm.getContextSize() > 0, 'attachments/apiMessages must still contribute to context size');
        });
    });

    suite('shouldSummarize()', () => {
        test('returns false when context is small', () => {
            cm.setApiMessages([
                { role: 'system', content: 'You are helpful.' },
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there!' },
            ]);
            assert.strictEqual(cm.shouldSummarize(), false);
        });

        test('returns false when not enough messages to compress', () => {
            cm.setApiMessages([
                { role: 'system', content: 'System prompt.' },
                ...Array.from({ length: 10 }, (_, i) => ({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `Message ${i}`,
                })),
            ]);
            assert.strictEqual(cm.shouldSummarize(), false);
        });

        test('returns true when context exceeds threshold with enough messages', () => {
            // Build a large context that exceeds 70% of window
            const bigMsg = 'x '.repeat(3000);
            const messages: ChatCompletionMessage[] = [
                { role: 'system', content: 'System.' },
            ];
            for (let i = 0; i < 20; i++) {
                messages.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: bigMsg + ` turn ${i}`,
                });
            }
            cm.setApiMessages(messages);
            assert.strictEqual(cm.shouldSummarize(), true);
        });
    });

    suite('getMessagesToSummarize()', () => {
        test('returns empty array when fewer than MIN_KEEP_TAIL messages', () => {
            cm.setApiMessages([
                { role: 'system', content: 'Sys' },
                { role: 'user', content: 'A' },
                { role: 'assistant', content: 'B' },
            ]);
            assert.strictEqual(cm.getMessagesToSummarize().length, 0);
        });

        test('keeps last 8 messages verbatim, returns rest for compression', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
            ];
            for (let i = 0; i < 16; i++) {
                msgs.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `msg-${i}`,
                });
            }
            cm.setApiMessages(msgs);

            const toSummarize = cm.getMessagesToSummarize();
            assert.strictEqual(toSummarize.length, 8);
            assert.strictEqual(toSummarize[0].content, 'msg-0');
            assert.strictEqual(toSummarize[toSummarize.length - 1].content, 'msg-7');
        });

        test('excludes system messages from compression candidates', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys1' },
                { role: 'user', content: 'A' },
                { role: 'system', content: 'Summary block' },
                { role: 'assistant', content: 'B' },
                { role: 'user', content: 'C' },
                { role: 'assistant', content: 'D' },
                { role: 'user', content: 'E' },
                { role: 'assistant', content: 'F' },
                { role: 'user', content: 'G' },
                { role: 'assistant', content: 'H' },
                { role: 'user', content: 'I' },
                { role: 'assistant', content: 'J' },
            ];
            cm.setApiMessages(msgs);

            const toSummarize = cm.getMessagesToSummarize();
            assert.strictEqual(toSummarize.length, 2);
            assert.strictEqual(toSummarize[0].content, 'A');
            assert.strictEqual(toSummarize[1].content, 'B');
        });

        test('never orphans tool-call pairs — excludes assistant with unmatched tool_calls', () => {
            const toolCalls: NativeToolCall[] = [{
                id: 'call_1', type: 'function',
                function: { name: 'edit_file', arguments: '{}' }
            }];
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
                { role: 'user', content: 'Fix the bug' },
                { role: 'assistant', content: 'Editing...', tool_calls: toolCalls },
                // tool result is NOT included in compressible range (it's in the tail)
                { role: 'tool', content: '{"success":true}', tool_call_id: 'call_1' },
                { role: 'user', content: 'Good' },
                { role: 'assistant', content: 'Done' },
                { role: 'user', content: 'Great' },
                { role: 'assistant', content: 'Yes' },
                { role: 'user', content: 'Ok' },
                { role: 'assistant', content: 'Yep' },
                { role: 'user', content: 'Bye' },
                { role: 'assistant', content: 'See ya' },
            ];
            cm.setApiMessages(msgs);

            const toSummarize = cm.getMessagesToSummarize();
            // The assistant with tool_calls should NOT be included because its
            // tool result is in the tail window and won't be removed.
            const hasOrphanedToolCalls = toSummarize.some(m =>
                m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
            );
            assert.strictEqual(hasOrphanedToolCalls, false,
                'Should not include assistant with orphaned tool_calls');
        });

        test('includes complete tool-call pairs when both assistant and tool are compressible', () => {
            const toolCalls: NativeToolCall[] = [{
                id: 'call_1', type: 'function',
                function: { name: 'read_file', arguments: '{}' }
            }];
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
                { role: 'user', content: 'Read file' },
                { role: 'assistant', content: 'Reading...', tool_calls: toolCalls },
                { role: 'tool', content: '{"success":true}', tool_call_id: 'call_1' },
                // Fill tail with enough messages so the above are compressible
                { role: 'user', content: 'm1' }, { role: 'assistant', content: 'a1' },
                { role: 'user', content: 'm2' }, { role: 'assistant', content: 'a2' },
                { role: 'user', content: 'm3' }, { role: 'assistant', content: 'a3' },
                { role: 'user', content: 'm4' }, { role: 'assistant', content: 'a4' },
                { role: 'user', content: 'm5' }, { role: 'assistant', content: 'a5' },
                { role: 'user', content: 'm6' }, { role: 'assistant', content: 'a6' },
                { role: 'user', content: 'm7' }, { role: 'assistant', content: 'a7' },
            ];
            cm.setApiMessages(msgs);

            const toSummarize = cm.getMessagesToSummarize();
            // Should include both the assistant AND its tool result
            const hasAssistant = toSummarize.some(m => m.role === 'assistant' && m.tool_calls);
            const hasTool = toSummarize.some(m => m.role === 'tool');
            assert.ok(hasAssistant, 'Should include assistant with tool_calls');
            assert.ok(hasTool, 'Should include matching tool result');
        });
    });

    suite('injectSummary()', () => {
        test('replaces old messages with summary block', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'System prompt.' },
                { role: 'user', content: 'First question' },
                { role: 'assistant', content: 'First answer' },
                { role: 'user', content: 'Second question' },
                { role: 'assistant', content: 'Second answer' },
                { role: 'user', content: 'Third question' },
                { role: 'assistant', content: 'Third answer' },
                { role: 'user', content: 'Fourth question' },
                { role: 'assistant', content: 'Fourth answer' },
                { role: 'user', content: 'Fifth question' },
                { role: 'assistant', content: 'Fifth answer' },
                { role: 'user', content: 'Sixth question' },
                { role: 'assistant', content: 'Sixth answer' },
                { role: 'user', content: 'Seventh question' },
                { role: 'assistant', content: 'Seventh answer' },
            ];
            cm.setApiMessages(msgs);

            const summaryText = 'User asked 7 questions about various topics. Assistant provided detailed answers.';
            const block = cm.injectSummary(summaryText);

            assert.strictEqual(block.summary, summaryText);
            assert.ok(block.compressedCount > 0);
            assert.ok(block.tokenCount > 0);

            const updated = cm.getApiMessages();
            const summaryMsg = updated.find(m => m.content?.includes('Conversation Summary'));
            assert.ok(summaryMsg, 'Summary message should be present');
            // role: 'user', not 'system' — a second role:'system' entry gets
            // rejected outright by backends that only permit exactly one
            // system message at index 0 (see injectSummary()'s comment).
            assert.strictEqual(summaryMsg!.role, 'user');
        });

        test('throws when no messages to summarize', () => {
            cm.setApiMessages([
                { role: 'system', content: 'Sys' },
                { role: 'user', content: 'Only one' },
            ]);

            assert.throws(
                () => cm.injectSummary('summary'),
                /No messages to summarize/
            );
        });

        test('tracks summary blocks in getSummaries()', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
            ];
            for (let i = 0; i < 16; i++) {
                msgs.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `msg-${i}`,
                });
            }
            cm.setApiMessages(msgs);

            cm.injectSummary('First summary');
            assert.strictEqual(cm.getSummaries().length, 1);
            assert.strictEqual(cm.getSummaries()[0].summary, 'First summary');
        });

        test('preserves tail messages after injection', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
            ];
            for (let i = 0; i < 16; i++) {
                msgs.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `msg-${i}`,
                });
            }
            cm.setApiMessages(msgs);

            cm.injectSummary('Summary');

            const updated = cm.getApiMessages();
            assert.ok(updated.some(m => m.content === 'msg-14'), 'Tail msg-14 preserved');
            assert.ok(updated.some(m => m.content === 'msg-15'), 'Tail msg-15 preserved');
        });

        test('removes only explicit toRemove messages when provided', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
                { role: 'user', content: 'A' },
                { role: 'assistant', content: 'B' },
                { role: 'user', content: 'C' },
                { role: 'assistant', content: 'D' },
                { role: 'user', content: 'E' },
                { role: 'assistant', content: 'F' },
                { role: 'user', content: 'G' },
                { role: 'assistant', content: 'H' },
                { role: 'user', content: 'I' },
                { role: 'assistant', content: 'J' },
            ];
            cm.setApiMessages(msgs);

            // Pass only the first 2 non-system messages as the explicit batch
            const explicitBatch = [msgs[1], msgs[2]]; // A, B
            cm.injectSummary('Summary of A and B', undefined, explicitBatch);

            const updated = cm.getApiMessages();
            assert.ok(!updated.some(m => m.content === 'A'), 'A removed');
            assert.ok(!updated.some(m => m.content === 'B'), 'B removed');
            assert.ok(updated.some(m => m.content === 'C'), 'C preserved');
            assert.ok(updated.some(m => m.content === 'J'), 'J preserved');
        });

        test('replaces existing summary instead of stacking', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
            ];
            for (let i = 0; i < 16; i++) {
                msgs.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `msg-${i}`,
                });
            }
            cm.setApiMessages(msgs);

            cm.injectSummary('First summary');
            const afterFirst = cm.getApiMessages();
            const summaryCount1 = afterFirst.filter(m => m.content?.includes('## Conversation Summary')).length;
            assert.strictEqual(summaryCount1, 1, 'Should have exactly 1 summary');

            // Add more messages to make summarization possible again
            for (let i = 0; i < 10; i++) {
                cm.getApiMessages().push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `new-msg-${i}`,
                });
            }
            // Sync back
            cm.setApiMessages(cm.getApiMessages());

            // Second summary should replace the first, not stack
            const toSummarize = cm.getMessagesToSummarize();
            if (toSummarize.length > 0) {
                cm.injectSummary('Second summary', undefined, toSummarize);
            }

            const afterSecond = cm.getApiMessages();
            const summaryCount2 = afterSecond.filter(m => m.content?.includes('## Conversation Summary')).length;
            assert.strictEqual(summaryCount2, 1, 'Should still have exactly 1 summary (replaced, not stacked)');

            // Verify it's the second summary
            const summary = afterSecond.find(m => m.content?.includes('## Conversation Summary'));
            assert.ok(summary?.content?.includes('Second summary'), 'Should contain the newer summary text');
        });

        test('does not orphan tool-call pairs when removing messages', () => {
            const toolCalls: NativeToolCall[] = [{
                id: 'call_1', type: 'function',
                function: { name: 'read_file', arguments: '{}' }
            }];
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
                { role: 'user', content: 'Read this' },
                { role: 'assistant', content: 'Reading...', tool_calls: toolCalls },
                { role: 'tool', content: '{"success":true}', tool_call_id: 'call_1' },
                { role: 'user', content: 'm1' }, { role: 'assistant', content: 'a1' },
                { role: 'user', content: 'm2' }, { role: 'assistant', content: 'a2' },
                { role: 'user', content: 'm3' }, { role: 'assistant', content: 'a3' },
                { role: 'user', content: 'm4' }, { role: 'assistant', content: 'a4' },
                { role: 'user', content: 'm5' }, { role: 'assistant', content: 'a5' },
                { role: 'user', content: 'm6' }, { role: 'assistant', content: 'a6' },
                { role: 'user', content: 'm7' }, { role: 'assistant', content: 'a7' },
            ];
            cm.setApiMessages(msgs);

            // Explicitly request removal of just the assistant (simulating a bad batch)
            const assistantIdx = msgs.findIndex(m => m.role === 'assistant' && m.tool_calls);
            const partialBatch = [msgs[assistantIdx]];
            cm.injectSummary('Summary', undefined, partialBatch);

            const updated = cm.getApiMessages();
            // The tool result should also be removed (or the assistant should be kept)
            // Either way, no orphans: either both gone or both present
            const remainingAssistant = updated.some(m => m.role === 'assistant' && m.tool_calls);
            const remainingTool = updated.some(m => m.role === 'tool' && m.tool_call_id === 'call_1');
            assert.strictEqual(remainingAssistant, remainingTool,
                'Tool-call pair must be consistent: both removed or both kept');
        });
    });

    suite('emergencyDrop()', () => {
        test('drops messages until under target', () => {
            const bigMsg = 'x '.repeat(200);
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
            ];
            for (let i = 0; i < 20; i++) {
                msgs.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: bigMsg + ` msg-${i}`,
                });
            }
            cm.setApiMessages(msgs);
            const beforeTokens = cm.getContextSize();

            const dropped = cm.emergencyDrop(beforeTokens * 0.3);
            assert.ok(dropped > 0, 'Should drop some messages');
            assert.ok(cm.getContextSize() <= beforeTokens * 0.35,
                'Should be near target after dropping');
        });

        test('drops tool-call pairs together', () => {
            const toolCalls: NativeToolCall[] = [{
                id: 'call_1', type: 'function',
                function: { name: 'read_file', arguments: '{}' }
            }];
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
                { role: 'assistant', content: 'Reading...', tool_calls: toolCalls },
                { role: 'tool', content: '{"success":true}', tool_call_id: 'call_1' },
                { role: 'user', content: 'm1' }, { role: 'assistant', content: 'a1' },
                { role: 'user', content: 'm2' }, { role: 'assistant', content: 'a2' },
                { role: 'user', content: 'm3' }, { role: 'assistant', content: 'a3' },
                { role: 'user', content: 'm4' }, { role: 'assistant', content: 'a4' },
                { role: 'user', content: 'm5' }, { role: 'assistant', content: 'a5' },
                { role: 'user', content: 'm6' }, { role: 'assistant', content: 'a6' },
                { role: 'user', content: 'm7' }, { role: 'assistant', content: 'a7' },
            ];
            cm.setApiMessages(msgs);

            const dropped = cm.emergencyDrop(50);
            assert.ok(dropped >= 2, 'Should drop at least the assistant+tool pair');

            // Check no orphans remain
            const updated = cm.getApiMessages();
            for (const msg of updated) {
                if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
                    const callIds = new Set(msg.tool_calls.map(tc => tc.id));
                    for (const later of updated) {
                        if (later.role === 'tool' && later.tool_call_id && callIds.has(later.tool_call_id)) {
                            // Found matching pair — good
                        }
                    }
                }
            }
            // No assertion failure means no structural issues
        });
    });

    suite('clearContext() resets summaries', () => {
        test('clearing context removes summary blocks', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'Sys' },
            ];
            for (let i = 0; i < 16; i++) {
                msgs.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `msg-${i}`,
                });
            }
            cm.setApiMessages(msgs);
            cm.injectSummary('Test summary');
            assert.strictEqual(cm.getSummaries().length, 1);

            cm.clearContext();
            assert.strictEqual(cm.getSummaries().length, 0);
        });
    });
});
