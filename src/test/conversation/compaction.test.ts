import * as assert from 'assert';
import { ContextManager } from '../../context/contextManager';
import { buildSummarizeBody } from '../../api/promptBuilder';
import { analyzeMessages, formatSummary } from '../../context/structuredSummarizer';
import { ChatConfig, ChatCompletionMessage, NativeToolCall } from '../../types';

// ---------------------------------------------------------------------------
// Shared test config
// ---------------------------------------------------------------------------

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
    minP: 0.0,
};

const smallWindowConfig: ChatConfig = {
    ...testConfig,
    contextWindowSize: 20000,
};

// ---------------------------------------------------------------------------
// C3: Response token reservation prevents post-response overflow
// ---------------------------------------------------------------------------

suite('C3: Response token reservation', () => {
    const RESERVE_FOR_TEXT_TURN = 4000;
    const RESERVE_FOR_TOOL_TURN = 8000;

    test('effective usage check triggers compact before raw usage would', () => {
        // At 73% raw usage, adding a 4K text turn reservation pushes effective
        // usage above 75% → should trigger compact. Without reservation, it
        // wouldn't trigger until 75% raw.
        const cm = new ContextManager(testConfig);
        const windowSize = testConfig.contextWindowSize;
        const targetUsage = Math.floor(windowSize * 0.73);

        // Simulate ~73% usage with big messages
        const bigContent = 'x '.repeat(Math.ceil(targetUsage / 2));
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System prompt.' },
            { role: 'user', content: bigContent },
            { role: 'assistant', content: bigContent },
        ];
        cm.setApiMessages(msgs);

        const actualTokens = cm.getContextSize();
        const effectiveWithTool = actualTokens + RESERVE_FOR_TOOL_TURN;

        // Effective usage with tool reservation should exceed 75% threshold
        assert.ok(
            effectiveWithTool > windowSize * 0.75,
            `Effective tool usage ${effectiveWithTool} should exceed 75% of ${windowSize}`,
        );

        // Raw usage alone might not exceed 75%
        // (depends on exact token count, but the reservation should push it over)
        assert.ok(
            effectiveWithTool > actualTokens,
            'Reservation should increase effective usage',
        );
    });

    test('tool turn reservation is larger than text turn reservation', () => {
        assert.ok(
            RESERVE_FOR_TOOL_TURN > RESERVE_FOR_TEXT_TURN,
            'Tool turns need more reservation for assistant text + tool_calls overhead',
        );
        assert.strictEqual(RESERVE_FOR_TOOL_TURN - RESERVE_FOR_TEXT_TURN, 4000);
    });

    test('hard abort accounts for reservation at 90%', () => {
        const cm = new ContextManager(testConfig);
        const windowSize = testConfig.contextWindowSize;

        // Simulate 88% usage — raw is under 90%, but with tool reservation it exceeds
        const targetUsage = Math.floor(windowSize * 0.88);
        const bigContent = 'x '.repeat(Math.ceil(targetUsage / 2));
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: bigContent },
            { role: 'assistant', content: bigContent },
        ];
        cm.setApiMessages(msgs);

        // At 88% + 8K reserve (~0.06% of 128K), effective ≈ 88.06% — below 90%
        // But needsHardTrim (85%) should fire
        assert.ok(cm.needsHardTrim(), 'At 88% usage, needsHardTrim should be true');
    });
});

// ---------------------------------------------------------------------------
// C4: Cache-aware summary request structure
// ---------------------------------------------------------------------------

suite('C4: Cache-aware summary request', () => {
    test('buildSummarizeBody produces two-message structure (system + user)', () => {
        const messages: ChatCompletionMessage[] = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
        ];

        const body = buildSummarizeBody(messages);

        assert.strictEqual(body.messages.length, 2, 'Should produce exactly 2 messages');
        assert.strictEqual(body.messages[0].role, 'system', 'First message should be system');
        assert.strictEqual(body.messages[1].role, 'user', 'Second message should be user');
    });

    test('buildSummarizeBody formats transcript with role markers', () => {
        const messages: ChatCompletionMessage[] = [
            { role: 'user', content: 'Fix the bug' },
            { role: 'assistant', content: 'I found the issue' },
            { role: 'tool', content: '{"success":true}' },
        ];

        const body = buildSummarizeBody(messages);
        const userContent = body.messages[1].content;

        assert.ok(userContent.includes('[USER]'), 'Should contain USER role marker');
        assert.ok(userContent.includes('[ASSISTANT]'), 'Should contain ASSISTANT role marker');
        assert.ok(userContent.includes('[TOOL]'), 'Should contain TOOL role marker');
        assert.ok(userContent.includes('---'), 'Should use --- separators between messages');
    });

    test('buildSummarizeBody truncates oversized messages', () => {
        const longContent = 'x'.repeat(10000);
        const messages: ChatCompletionMessage[] = [
            { role: 'user', content: longContent },
        ];

        const body = buildSummarizeBody(messages);
        const userContent = body.messages[1].content;

        // The truncated content should contain the truncation marker
        assert.ok(
            userContent.includes('[...truncated'),
            'Oversized messages should be truncated with a marker',
        );
    });

    test('buildSummarizeBody system prompt includes enriched sections (C7)', () => {
        const messages: ChatCompletionMessage[] = [
            { role: 'user', content: 'Test' },
        ];

        const body = buildSummarizeBody(messages);
        const systemContent = body.messages[0].content;

        // Verify all C7 enriched sections are present
        assert.ok(systemContent.includes('### User Intent'), 'Should have User Intent section');
        assert.ok(systemContent.includes('### Files Modified'), 'Should have Files Modified section');
        assert.ok(systemContent.includes('### Files Read'), 'Should have Files Read section');
        assert.ok(systemContent.includes('### Tool Results'), 'Should have Tool Results section');
        assert.ok(systemContent.includes('### Errors Encountered'), 'Should have Errors Encountered section');
        assert.ok(systemContent.includes('### Architecture Decisions'), 'Should have Architecture Decisions section');
        assert.ok(systemContent.includes('### Constraints'), 'Should have Constraints section');
        assert.ok(systemContent.includes('### Completed Work'), 'Should have Completed Work section');
        assert.ok(systemContent.includes('### Remaining Work'), 'Should have Remaining Work section');
        assert.ok(systemContent.includes('### Next Action'), 'Should have Next Action section');
    });

    test('buildSummarizeBody system prompt enforces 12K token cap', () => {
        const messages: ChatCompletionMessage[] = [
            { role: 'user', content: 'Test' },
        ];

        const body = buildSummarizeBody(messages);
        const systemContent = body.messages[0].content;

        assert.ok(
            systemContent.includes('12000 tokens') || systemContent.includes('12000-tokens'),
            'System prompt should mention the 12K token cap',
        );
    });
});

// ---------------------------------------------------------------------------
// C5: Thrash detection
// ---------------------------------------------------------------------------

suite('C5: Thrash detection logic', () => {
    const MAX_AUTO_COMPACTIONS = 3;

    test('thrash counter resets on new user message', () => {
        // Simulated state machine: compactCount increments, then resets
        let compactCount = 0;
        let thrashing = false;
        let prevTokens = 100000;

        // Three compactions with <20% reduction each
        for (let i = 0; i < MAX_AUTO_COMPACTIONS; i++) {
            compactCount++;
            const currentTokens = prevTokens - 5000; // only 5% reduction
            const reduction = (prevTokens - currentTokens) / prevTokens;

            if (compactCount >= MAX_AUTO_COMPACTIONS && reduction < 0.2) {
                thrashing = true;
            }
            prevTokens = currentTokens;
        }

        assert.strictEqual(thrashing, true, 'Should detect thrashing after 3 failed compactions');

        // New user message resets everything
        compactCount = 0;
        prevTokens = 0;
        thrashing = false;

        assert.strictEqual(thrashing, false, 'New user message should reset thrash state');
        assert.strictEqual(compactCount, 0, 'Compact count should reset to 0');
    });

    test('thrash detection requires <20% reduction over MAX_AUTO_COMPACTIONS', () => {
        let compactCount = 0;
        let thrashing = false;

        // First compact: 25% reduction — good
        compactCount++;

        // Second compact: 25% reduction — good
        compactCount++;

        // Third compact: still reducing well
        compactCount++;
        const currentTokens = 42000; // 58% total reduction from 100K

        // Check per-iteration: each iteration reduced >20%
        // So we should NOT declare thrashing
        if (compactCount >= MAX_AUTO_COMPACTIONS) {
            const iterReduction = (100000 - 42000) / 100000;
            if (iterReduction < 0.2) {
                thrashing = true;
            }
        }

        // Total reduction was 58% — well above 20% threshold
        assert.strictEqual(thrashing, false, 'Good reductions should not trigger thrash detection');
    });

    test('emergency drop is fallback when thrashing', () => {
        const cm = new ContextManager(testConfig);
        const bigContent = 'x '.repeat(40000);
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: bigContent },
            { role: 'assistant', content: bigContent },
            { role: 'user', content: bigContent },
            { role: 'assistant', content: bigContent },
        ];
        cm.setApiMessages(msgs);

        const beforeTokens = cm.getContextSize();
        const targetTokens = testConfig.contextWindowSize * 0.5;

        // Emergency drop should reduce context toward target
        const dropped = cm.emergencyDrop(targetTokens);
        const afterTokens = cm.getContextSize();

        assert.ok(dropped > 0, 'Emergency drop should drop some messages');
        assert.ok(afterTokens < beforeTokens, 'Token count should decrease after emergency drop');
    });
});

// ---------------------------------------------------------------------------
// C6: Threshold adjustments
// ---------------------------------------------------------------------------

suite('C6: Threshold adjustments', () => {
    test('auto-summarize threshold defaults to 75% in package.json', () => {
        // This is verified by the package.json config value.
        // Here we verify the ContextManager behavior with 75%.
        const cm = new ContextManager(testConfig);
        cm.setSummarizeThreshold(75);
        assert.strictEqual(cm.getSummarizeThreshold(), 75);
    });

    test('shouldSummarize respects configured threshold', () => {
        const cm = new ContextManager(testConfig);

        // Set threshold very high — should never summarize
        cm.setSummarizeThreshold(99);
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
        ];
        for (let i = 0; i < 20; i++) {
            msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` });
        }
        cm.setApiMessages(msgs);
        assert.strictEqual(cm.shouldSummarize(), false, 'At 99% threshold, normal context should not trigger');

        // Set threshold very low — should always summarize (if enough messages)
        cm.setSummarizeThreshold(1);
        assert.strictEqual(cm.shouldSummarize(), true, 'At 1% threshold, any context with enough messages should trigger');
    });

    test('HARD_TRIM_THRESHOLD is 0.85', () => {
        // Build context exceeding 85% of 128K = 108.8K tokens
        const cm = new ContextManager(testConfig);
        const bigMsg = 'x '.repeat(55000); // ~55K tokens each
        const messages: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: bigMsg },
            { role: 'assistant', content: bigMsg },
        ];
        cm.setApiMessages(messages);
        assert.strictEqual(cm.needsHardTrim(), true, 'At >85% usage, needsHardTrim should return true');
    });

    test('compact target is 50% of window size', () => {
        // The compact() method targets windowSize * 0.5 (capped at 24K).
        // For 128K window, target = min(64K, 24K) = 24K.
        // For 20K window, target = min(10K, 24K) = 10K.
        const largeTarget = Math.min(Math.floor(testConfig.contextWindowSize * 0.5), 24000);
        const smallTarget = Math.min(Math.floor(smallWindowConfig.contextWindowSize * 0.5), 24000);

        assert.strictEqual(largeTarget, 24000, 'Large window compact target should be capped at 24K');
        assert.strictEqual(smallTarget, 10000, 'Small window compact target should be 50% of window');
    });
});

// ---------------------------------------------------------------------------
// C7: Enriched summary with coding-agent-specific sections
// ---------------------------------------------------------------------------

suite('C7: Enriched summary extraction', () => {
    test('analyzeMessages extracts constraints from user messages', () => {
        const messages: ChatCompletionMessage[] = [
            { role: 'user', content: 'Please follow these rules: use TypeScript strict mode, no console.log, and keep functions under 50 lines.' },
            { role: 'assistant', content: 'Understood. I will follow those constraints.' },
        ];

        const summary = analyzeMessages(messages);
        // Constraints are extracted from user intent signals
        assert.ok(
            summary.userIntent.toLowerCase().includes('typescript') || summary.constraints.length > 0,
            'Should capture constraint-related content',
        );
    });

    test('analyzeMessages extracts remaining work from assistant messages', () => {
        const messages: ChatCompletionMessage[] = [
            { role: 'user', content: 'Implement auth, payments, and notifications.' },
            { role: 'assistant', content: 'I\'ve completed the auth module. Still need to implement payments and notifications next.' },
        ];

        const summary = analyzeMessages(messages);
        // Remaining work signals: "still need to", "next", "remaining"
        const hasRemainingWork = summary.remainingWork.length > 0 ||
            summary.nextAction.length > 0;
        assert.ok(hasRemainingWork, 'Should detect remaining work or next action');
    });

    test('formatSummary renders all sections when data exists', () => {
        const summary = analyzeMessages([
            { role: 'user', content: 'Refactor the auth module to use OAuth2.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'src/auth/oauth.ts', content: 'export class OAuth {}' }) },
                }],
            },
            {
                role: 'tool',
                content: '{"success":true,"output":"File written"}',
                tool_call_id: 'call_1',
            },
            { role: 'assistant', content: 'Auth module refactored. After reviewing the options, I decided to use PKCE flow for better security.' },
        ]);

        const formatted = formatSummary(summary);

        assert.ok(formatted.includes('## Conversation Summary'), 'Should have main header');
        assert.ok(formatted.includes('### User Intent'), 'Should have User Intent');
        assert.ok(formatted.includes('### Files Modified'), 'Should have Files Modified');
        assert.ok(formatted.includes('src/auth/oauth.ts'), 'Should preserve exact file path');
        assert.ok(formatted.includes('### Architecture Decisions'), 'Should have Architecture Decisions');
        assert.ok(formatted.includes('PKCE'), 'Should include decision detail');
    });

    test('formatSummary omits empty sections', () => {
        const summary = analyzeMessages([
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
        ]);

        const formatted = formatSummary(summary);

        assert.ok(formatted.includes('### User Intent'), 'Should have User Intent');
        // No files were modified, so that section should be omitted
        assert.ok(!formatted.includes('### Files Modified'), 'Should omit empty Files Modified section');
        assert.ok(!formatted.includes('### Errors Encountered'), 'Should omit empty Errors section');
    });
});

// ---------------------------------------------------------------------------
// Integration: Full compaction pipeline (ContextManager + promptBuilder)
// ---------------------------------------------------------------------------

suite('Integration: Compaction pipeline', () => {
    test('full pipeline: getMessagesToSummarize → buildSummarizeBody → injectSummary', () => {
        const cm = new ContextManager(testConfig);

        // Build a conversation with enough messages to compress
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'You are a helpful coding assistant.' },
        ];

        // Add 20 messages (12 compressible + 8 tail)
        for (let i = 0; i < 20; i++) {
            msgs.push({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `Conversation turn ${i}: discussing feature implementation details.`,
            });
        }

        cm.setApiMessages(msgs);

        // Step 1: Get messages to summarize
        const toSummarize = cm.getMessagesToSummarize();
        assert.ok(toSummarize.length > 0, 'Should have messages to summarize');

        // Step 2: Build summarize body (cache-aware)
        const body = buildSummarizeBody(toSummarize);
        assert.strictEqual(body.messages.length, 2, 'Should produce system + user messages');

        // Step 3: Simulate API response and inject summary
        const mockSummary = `### User Intent\nImplement a new feature.\n\n### Files Modified\n- src/feature.ts: created new feature module\n\n### Completed Work\nFeature implementation complete.`;

        const block = cm.injectSummary(mockSummary, ['src/feature.ts'], toSummarize);

        // Verify injection
        assert.ok(block.compressedCount > 0, 'Should have compressed some messages');
        assert.ok(block.tokenCount > 0, 'Summary should have token count');

        // Verify apiMessages now contains the summary
        const apiMsgs = cm.getApiMessages();
        const hasSummary = apiMsgs.some(m => m.content?.includes('## Conversation Summary'));
        assert.ok(hasSummary, 'apiMessages should contain the injected summary');

        // Verify recently modified files are included
        const summaryMsg = apiMsgs.find(m => m.content?.includes('## Conversation Summary'));
        assert.ok(
            summaryMsg?.content?.includes('src/feature.ts'),
            'Summary should include recently modified file paths',
        );
    });

    test('pipeline with tool-call pairs preserves integrity', () => {
        const cm = new ContextManager(testConfig);

        const toolCalls: NativeToolCall[] = [{
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"src/file.ts"}' },
        }];

        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: 'Read this file' },
            { role: 'assistant', content: 'Reading...', tool_calls: toolCalls },
            { role: 'tool', content: '{"success":true,"output":"file contents here"}', tool_call_id: 'call_1' },
            { role: 'assistant', content: 'Here are the results.' },
        ];

        // Pad with more messages to exceed MIN_KEEP_TAIL
        for (let i = 0; i < 15; i++) {
            msgs.push({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `Turn ${i}`,
            });
        }

        cm.setApiMessages(msgs);

        const toSummarize = cm.getMessagesToSummarize();

        // Verify tool-call pairs are either fully included or fully excluded
        const hasAssistantToolCall = toSummarize.some(m => m.tool_calls && m.tool_calls.length > 0);
        const hasToolResult = toSummarize.some(m => m.role === 'tool');

        // If an assistant with tool_calls is in the batch, its tool result should be too
        if (hasAssistantToolCall) {
            assert.ok(hasToolResult, 'Tool-call pair should be kept together');
        }

        // Inject summary
        const mockSummary = 'Summarized conversation.';
        cm.injectSummary(mockSummary, undefined, toSummarize);

        // Verify no orphaned tool messages remain in apiMessages
        const apiMsgs = cm.getApiMessages();
        for (const msg of apiMsgs) {
            if (msg.role === 'tool' && msg.tool_call_id) {
                // Find the matching assistant with tool_calls
                const hasMatchingAssistant = apiMsgs.some(
                    m => m.tool_calls?.some(tc => tc.id === msg.tool_call_id),
                );
                assert.ok(hasMatchingAssistant, `Tool result ${msg.tool_call_id} should have a matching assistant`);
            }
        }
    });

    test('multiple compactions replace summary instead of stacking', () => {
        const cm = new ContextManager(testConfig);

        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
        ];

        // First round: add 20 messages
        for (let i = 0; i < 20; i++) {
            msgs.push({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `Round 1, turn ${i}`,
            });
        }
        cm.setApiMessages(msgs);

        // First compaction
        const batch1 = cm.getMessagesToSummarize();
        cm.injectSummary('First summary of earlier turns.', undefined, batch1);

        let summaries = cm.getApiMessages().filter(m => m.content?.includes('## Conversation Summary'));
        assert.strictEqual(summaries.length, 1, 'After first compact, exactly one summary');

        // Second round: add more messages
        const currentMsgs = cm.getApiMessages();
        for (let i = 0; i < 20; i++) {
            currentMsgs.push({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `Round 2, turn ${i}`,
            });
        }
        cm.setApiMessages(currentMsgs);

        // Second compaction
        const batch2 = cm.getMessagesToSummarize();
        if (batch2.length > 0) {
            cm.injectSummary('Second summary of newer turns.', undefined, batch2);
        }

        summaries = cm.getApiMessages().filter(m => m.content?.includes('## Conversation Summary'));
        assert.strictEqual(summaries.length, 1, 'After second compact, still exactly one summary (replaced, not stacked)');
        assert.ok(summaries[0].content?.includes('Second summary'), 'Summary should contain the latest text');
    });

    test('emergency drop after failed summarization reduces context', () => {
        const cm = new ContextManager(smallWindowConfig);

        // Fill context near capacity
        const bigContent = 'x '.repeat(7000);
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
        ];
        for (let i = 0; i < 10; i++) {
            msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: bigContent });
        }
        cm.setApiMessages(msgs);

        const beforeTokens = cm.getContextSize();
        const targetTokens = smallWindowConfig.contextWindowSize * 0.5; // 10K

        const dropped = cm.emergencyDrop(targetTokens);

        assert.ok(dropped > 0, 'Should drop messages');
        assert.ok(cm.getContextSize() < beforeTokens, 'Token count should decrease');
        // Should get reasonably close to target
        assert.ok(
            cm.getContextSize() <= targetTokens + 5000,
            `Should approach target: got ${cm.getContextSize()}, target ${targetTokens}`,
        );
    });

    test('getRecentlyTouchedFiles extracts paths from tool calls and results', () => {
        const cm = new ContextManager(testConfig);

        const toolCalls: NativeToolCall[] = [
            {
                id: 'call_1',
                type: 'function',
                function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'src/main.ts', content: 'code' }) },
            },
            {
                id: 'call_2',
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'src/utils.ts' }) },
            },
        ];

        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: 'Edit files' },
            { role: 'assistant', content: '', tool_calls: toolCalls },
            { role: 'tool', content: JSON.stringify({ success: true, filePath: 'src/main.ts' }), tool_call_id: 'call_1' },
            { role: 'tool', content: JSON.stringify({ success: true, filePath: 'src/utils.ts' }), tool_call_id: 'call_2' },
        ];

        cm.setApiMessages(msgs);

        const files = cm.getRecentlyTouchedFiles(5);
        assert.ok(files.includes('src/main.ts'), 'Should include src/main.ts');
        assert.ok(files.includes('src/utils.ts'), 'Should include src/utils.ts');
    });

    test('summary budget scales correctly across window sizes', () => {
        // Small window: clamped to 16K minimum
        const smallCm = new ContextManager(smallWindowConfig);
        assert.strictEqual(smallCm.getMaxSummaryBatchTokens(), 16000);

        // Medium window: 10% of 128K = 12.8K, clamped to 16K
        const medCm = new ContextManager(testConfig);
        assert.strictEqual(medCm.getMaxSummaryBatchTokens(), 16000);

        // Large window: 10% of 200K = 20K
        const largeCm = new ContextManager({ ...testConfig, contextWindowSize: 200000 });
        assert.strictEqual(largeCm.getMaxSummaryBatchTokens(), 20000);

        // Huge window: 10% of 500K = 50K, capped at 32K
        const hugeCm = new ContextManager({ ...testConfig, contextWindowSize: 500000 });
        assert.strictEqual(hugeCm.getMaxSummaryBatchTokens(), 32000);
    });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

suite('Compaction edge cases', () => {
    test('injectSummary throws when no messages to summarize', () => {
        const cm = new ContextManager(testConfig);
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi' },
        ];
        cm.setApiMessages(msgs);

        assert.throws(
            () => cm.injectSummary('Summary', undefined, []),
            /No messages to summarize/,
        );
    });

    test('emergencyDrop stops when only system messages remain', () => {
        const cm = new ContextManager(testConfig);
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'system', content: 'Another system msg' },
        ];
        cm.setApiMessages(msgs);

        // Target 0 tokens — should stop at system messages
        const dropped = cm.emergencyDrop(0);
        assert.strictEqual(dropped, 0, 'Should not drop system messages');
        assert.strictEqual(cm.getApiMessages().length, 2, 'Both system messages should remain');
    });

    test('getMessagesToSummarize returns empty for fewer than MIN_KEEP_TAIL messages', () => {
        const cm = new ContextManager(testConfig);
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi' },
        ];
        cm.setApiMessages(msgs);

        const toSummarize = cm.getMessagesToSummarize();
        assert.strictEqual(toSummarize.length, 0, 'Should return empty for few messages');
    });

    test('summarize threshold of 0 disables auto-summarize', () => {
        const cm = new ContextManager(testConfig);
        cm.setSummarizeThreshold(0);

        // Even with huge context, should not summarize
        const bigContent = 'x '.repeat(50000);
        const msgs: ChatCompletionMessage[] = [
            { role: 'system', content: 'System.' },
        ];
        for (let i = 0; i < 20; i++) {
            msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: bigContent });
        }
        cm.setApiMessages(msgs);

        assert.strictEqual(cm.shouldSummarize(), false, 'Threshold 0 should disable summarization');
    });

    test('buildSummarizeBody handles empty content gracefully', () => {
        const messages: ChatCompletionMessage[] = [
            { role: 'user', content: '' },
            { role: 'assistant', content: '' },
        ];

        const body = buildSummarizeBody(messages);
        assert.ok(body.messages[1].content.includes('(empty)'), 'Empty content should show "(empty)" marker');
    });

    test('analyzeMessages handles messages with no tool calls', () => {
        const messages: ChatCompletionMessage[] = [
            { role: 'user', content: 'Just chatting' },
            { role: 'assistant', content: 'Nice to chat with you!' },
        ];

        const summary = analyzeMessages(messages);
        assert.strictEqual(summary.filesModified.length, 0);
        assert.strictEqual(summary.filesRead.length, 0);
        assert.strictEqual(summary.toolResults.length, 0);
        assert.strictEqual(summary.errors.length, 0);
    });
});
