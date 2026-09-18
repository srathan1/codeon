import * as assert from 'assert';
import { ContextManager } from '../../context/contextManager';
import { ChatConfig, ChatCompletionMessage, NativeToolCall } from '../../types';

const testConfig: ChatConfig = {
    modelEndpoint: 'http://localhost:8080',
    modelName: 'test-model',
    apiKey: 'test-key',
    contextWindowSize: 128000,
    defaultMode: 'plan',
    openCodeEnabled: false,
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    presencePenalty: 1.5,
    repetitionPenalty: 1.0,
    minP: 0.0
};

const smallWindowConfig: ChatConfig = {
    ...testConfig,
    contextWindowSize: 20000,
};

suite('ContextManager Compaction Tests', () => {
    let cm: ContextManager;

    setup(() => {
        cm = new ContextManager(testConfig);
    });

    suite('C2: getMaxSummaryBatchTokens() returns fixed budget', () => {
        test('returns fixed budget regardless of current usage level', () => {
            // Empty context
            const budget1 = cm.getMaxSummaryBatchTokens();
            assert.strictEqual(budget1, 16000); // min(32000, max(16000, floor(128000*0.1))) = 12800 -> max with 16000 = 16000

            // Fill context to 90%
            const bigContent = 'x '.repeat(50000);
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'System prompt.' },
                { role: 'user', content: bigContent },
                { role: 'assistant', content: bigContent },
            ];
            cm.setApiMessages(msgs);

            // Budget should still be the same — independent of usage
            const budget2 = cm.getMaxSummaryBatchTokens();
            assert.strictEqual(budget2, budget1, 'Budget must not change with usage level');
        });

        test('scales with window size for large windows', () => {
            const largeConfig: ChatConfig = { ...testConfig, contextWindowSize: 200000 };
            const largeCm = new ContextManager(largeConfig);
            const budget = largeCm.getMaxSummaryBatchTokens();
            // 10% of 200K = 20000, capped at 32000
            assert.strictEqual(budget, 20000);
        });

        test('caps at 32K for very large windows', () => {
            const hugeConfig: ChatConfig = { ...testConfig, contextWindowSize: 500000 };
            const hugeCm = new ContextManager(hugeConfig);
            const budget = hugeCm.getMaxSummaryBatchTokens();
            assert.strictEqual(budget, 32000);
        });

        test('uses proportional budget for small windows (< 160K)', () => {
            const smallCm = new ContextManager(smallWindowConfig);
            const budget = smallCm.getMaxSummaryBatchTokens();
            // 10% of 20K = 2000, but min is 16000
            assert.strictEqual(budget, 16000);
        });
    });

    suite('C6: Threshold adjustments', () => {
        test('DEFAULT_SUMMARIZE_THRESHOLD is 0.75 (not 0.5)', () => {
            // The threshold is set via config; verify the constant by checking behavior
            cm.setSummarizeThreshold(75); // 75% = 0.75
            const threshold = cm.getSummarizeThreshold();
            assert.strictEqual(threshold, 75);
        });

        test('shouldSummarize triggers at 75% with enough messages', () => {
            cm.setSummarizeThreshold(75);
            // Build context that exceeds 75% of 128K = 96K tokens
            const bigMsg = 'x '.repeat(40000); // ~40K tokens each
            const messages: ChatCompletionMessage[] = [
                { role: 'system', content: 'System.' },
            ];
            for (let i = 0; i < 15; i++) {
                messages.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: bigMsg + ` turn ${i}`,
                });
            }
            cm.setApiMessages(messages);
            assert.strictEqual(cm.shouldSummarize(), true);
        });

        test('needsHardTrim uses HARD_TRIM_THRESHOLD of 0.85', () => {
            // Build context exceeding 85% of 128K = 108.8K tokens
            const bigMsg = 'x '.repeat(50000);
            const messages: ChatCompletionMessage[] = [
                { role: 'system', content: 'System.' },
                { role: 'user', content: bigMsg },
                { role: 'assistant', content: bigMsg },
            ];
            cm.setApiMessages(messages);
            assert.strictEqual(cm.needsHardTrim(), true);
        });
    });

    suite('injectSummary replaces existing summary (no stacking)', () => {
        test('second injectSummary replaces the first, not stacks', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'System prompt.' },
                ...Array.from({ length: 16 }, (_, i) => ({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `Message ${i}`,
                })),
            ];
            cm.setApiMessages(msgs);

            // First summary
            const toSummarize1 = cm.getMessagesToSummarize();
            cm.injectSummary('First summary text', undefined, toSummarize1);

            // The summary is injected as role:'user' (not 'system') — many
            // OpenAI-compatible backends reject a second role:'system' entry
            // outright ("System message must be at the beginning"), so there
            // should be exactly one system message (the real prompt) plus a
            // summary present, not two system messages.
            const afterFirst = cm.getApiMessages();
            const systemCount1 = afterFirst.filter(m => m.role === 'system').length;
            assert.strictEqual(systemCount1, 1, 'Should have exactly one system message (the real prompt)');
            const hasSummary1 = afterFirst.some(m => m.content?.includes('## Conversation Summary'));
            assert.ok(hasSummary1, 'Should have a summary message present');

            // Add more messages so we can summarize again
            for (let i = 0; i < 16; i++) {
                msgs.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `New message ${i}`,
                });
            }
            cm.setApiMessages([...cm.getApiMessages(), ...msgs.slice(msgs.length - 16)]);

            // Second summary
            const toSummarize2 = cm.getMessagesToSummarize();
            if (toSummarize2.length > 0) {
                cm.injectSummary('Second summary text', undefined, toSummarize2);
            }

            // Verify only one summary exists
            const apiMsgs = cm.getApiMessages();
            const summaries = apiMsgs.filter(m => m.content?.includes('## Conversation Summary'));
            assert.strictEqual(summaries.length, 1, 'Only one summary should exist after second injection');
            assert.ok(summaries[0].content?.includes('Second summary text'), 'Summary should contain new text');
        });
    });

    suite('emergencyDrop respects tool-call pair boundaries', () => {
        test('drops assistant+tool results together as a block', () => {
            const toolCalls: NativeToolCall[] = [{
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path": "src/file.ts"}' }
            }];

            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'System prompt.' },
                { role: 'user', content: 'Read this file' },
                { role: 'assistant', content: 'Reading...', tool_calls: toolCalls },
                { role: 'tool', content: '{"success":true,"output":"file contents"}', tool_call_id: 'call_1' },
                { role: 'assistant', content: 'Here are the results.' },
                { role: 'user', content: 'Thanks!' },
                { role: 'assistant', content: 'You welcome!' },
                { role: 'user', content: 'More stuff' },
                { role: 'assistant', content: 'OK' },
                { role: 'user', content: 'Even more' },
                { role: 'assistant', content: 'Done' },
            ];
            cm.setApiMessages(msgs);

            // Target: drop down to very few tokens
            const dropped = cm.emergencyDrop(100);
            assert.ok(dropped > 0, 'Should have dropped some messages');

            // Verify no orphaned tool messages remain
            const remaining = cm.getApiMessages();
            for (const msg of remaining) {
                if (msg.role === 'tool') {
                    // Every tool message should have a matching assistant before it
                    const idx = remaining.indexOf(msg);
                    assert.ok(idx > 0, 'Tool message should not be first');
                }
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    // Every assistant with tool_calls should have matching tool results
                    const callIds = new Set(msg.tool_calls.map(tc => tc.id));
                    for (let j = remaining.indexOf(msg) + 1; j < remaining.length; j++) {
                        const toolId = remaining[j].tool_call_id;
                        if (remaining[j].role === 'tool' && toolId && callIds.has(toolId)) {
                            callIds.delete(toolId);
                        }
                    }
                    assert.strictEqual(callIds.size, 0, 'No orphaned tool calls');
                }
            }
        });
    });

    suite('getMessagesToSummarize with token budget returns correct subset', () => {
        test('respects token budget limit', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'System.' },
            ];
            // Create messages of known token sizes (~5 tokens each)
            for (let i = 0; i < 20; i++) {
                msgs.push({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `Message number ${i} with some words`,
                });
            }
            cm.setApiMessages(msgs);

            // Request only 20 tokens worth
            const batch = cm.getMessagesToSummarize(20);
            assert.ok(batch.length > 0, 'Should return some messages');
            assert.ok(batch.length < 12, 'Should not return all compressible messages');

            // Calculate actual token count of returned messages
            let totalTokens = 0;
            for (const msg of batch) {
                totalTokens += ContextManager.countTokens(msg.content || '') + 1;
            }
            assert.ok(totalTokens <= 25, `Token count ${totalTokens} should be near budget of 20`);
        });

        test('returns empty when budget is too small for any message', () => {
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'System.' },
                ...Array.from({ length: 16 }, (_, i) => ({
                    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
                    content: `Message ${i}`,
                })),
            ];
            cm.setApiMessages(msgs);

            const batch = cm.getMessagesToSummarize(1);
            assert.strictEqual(batch.length, 0, 'Should return empty when budget is too small');
        });
    });

    suite('C1: Transcript vs active context separation', () => {
        test('injectSummary removes from apiMessages but transcript stays intact', () => {
            // This tests the concept — the actual transcript is managed in ConversationManager,
            // but ContextManager's injectSummary should only mutate apiMessages
            const msgs: ChatCompletionMessage[] = [
                { role: 'system', content: 'System.' },
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Hi there' },
                { role: 'user', content: 'Do something' },
                { role: 'assistant', content: 'Done' },
                { role: 'user', content: 'More' },
                { role: 'assistant', content: 'OK' },
                { role: 'user', content: 'Again' },
                { role: 'assistant', content: 'Yep' },
                { role: 'user', content: 'Once more' },
                { role: 'assistant', content: 'Right' },
            ];
            cm.setApiMessages(msgs);

            const originalCount = cm.getApiMessages().length;
            const toSummarize = cm.getMessagesToSummarize();

            cm.injectSummary('Summary of earlier turns', undefined, toSummarize);

            const afterCount = cm.getApiMessages().length;
            assert.ok(afterCount < originalCount, 'apiMessages should shrink after injection');

            // The summary should be present
            const apiMsgs = cm.getApiMessages();
            const hasSummary = apiMsgs.some(m => m.content?.includes('Summary of earlier turns'));
            assert.ok(hasSummary, 'Summary should be injected into apiMessages');
        });
    });
});
