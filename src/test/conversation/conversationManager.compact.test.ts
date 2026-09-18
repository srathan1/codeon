import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConversationManager } from '../../conversation/conversationManager';
import { ContextManager } from '../../context/contextManager';
import { ModeManager } from '../../context/modeManager';
import { ChatStore } from '../../storage/chatStore';
import { ObservabilityService } from '../../observability/observability';
import { ChatCompletionMessage, ChatConfig } from '../../types';
import { ApiClient } from '../../api/apiClient';

const testConfig: ChatConfig = {
    modelEndpoint: 'http://localhost:8080',
    modelName: 'test-model',
    apiKey: 'test-key',
    contextWindowSize: 180000,
    defaultMode: 'build',
    openCodeEnabled: false,
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    presencePenalty: 1.5,
    repetitionPenalty: 1.0,
    minP: 0.0,
};

/** A message with enough distinct-word content to cost several thousand real tokens. */
function bigMessage(role: 'user' | 'assistant', label: string, wordCount: number): ChatCompletionMessage {
    const words = Array.from({ length: wordCount }, (_, i) => `${label}word${i}`).join(' ');
    return { role, content: words };
}

/**
 * A realistic user -> assistant(tool_calls) -> tool(result) turn, matching
 * what an actual coding-assistant conversation looks like (unlike plain
 * text messages, which don't exercise the tool-call-pairing logic in
 * getMessagesToSummarize()/_ensureToolCallPairsComplete()/emergencyDrop()
 * at all).
 */
function toolCallTurn(i: number, wordCount: number): ChatCompletionMessage[] {
    const callId = `call_${i}`;
    return [
        { role: 'user', content: `Please do task ${i}: ${Array.from({ length: 20 }, (_, j) => `req${i}_${j}`).join(' ')}` },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: callId, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/file${i}.ts` }) } }],
        },
        {
            role: 'tool',
            tool_call_id: callId,
            content: Array.from({ length: wordCount }, (_, j) => `out${i}_${j}`).join(' '),
        },
        { role: 'assistant', content: `Done with task ${i}.` },
    ];
}

suite('ConversationManager.compact() Tests', () => {
    let tmpDir: string;
    let posted: Record<string, unknown>[];
    let apiMessages: ChatCompletionMessage[];
    let contextManager: ContextManager;
    let chatStore: ChatStore;
    let cm: ConversationManager;
    let chatId: string;
    let summarizeCallCount: number;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeon-compact-test-'));
        posted = [];
        summarizeCallCount = 0;

        apiMessages = [{ role: 'system', content: 'You are a helpful assistant.' }];
        // 20 large user/assistant turns — well over MIN_KEEP_TAIL(8), and
        // large enough in total tokens to require multiple compact() rounds
        // to reach the ~24K target from the ~180K default window.
        for (let i = 0; i < 20; i++) {
            apiMessages.push(bigMessage(i % 2 === 0 ? 'user' : 'assistant', `turn${i}-`, 800));
        }

        contextManager = new ContextManager(testConfig);
        // Real usage always reaches compact() through sendMessage(), which
        // keeps contextManager synced via _syncContext() on every turn — by
        // the time a user can click /compact, contextManager already mirrors
        // apiMessages. Mirror that here so the test reflects reality instead
        // of an artificial "never synced" starting state.
        contextManager.setApiMessages([...apiMessages]);

        const modeManager = new ModeManager('build');
        chatStore = new ChatStore(tmpDir);
        const observability = new ObservabilityService(tmpDir);
        const created = chatStore.createChat('build');
        chatId = created.id;

        const fakeApiClient = {
            summarizeConversation: async (messages: ChatCompletionMessage[]) => {
                summarizeCallCount++;
                return `Summary of ${messages.length} earlier messages (call ${summarizeCallCount}).`;
            },
        } as unknown as ApiClient;

        let isProcessing = false;
        let abortController: AbortController | null = null;

        cm = new ConversationManager(
            apiMessages,
            () => fakeApiClient,
            () => { /* setApiClient no-op */ },
            () => null,
            () => { /* setToolCallHandler no-op */ },
            contextManager,
            modeManager,
            chatStore,
            null,
            observability,
            () => undefined,
            (msg) => { posted.push(msg); },
            () => isProcessing,
            (v) => { isProcessing = v; },
            () => abortController,
            (c) => { abortController = c; },
            () => chatId,
            () => undefined,
        );
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('reduces this.apiMessages (not just contextManager\'s internal copy) after compacting', async () => {
        const beforeCount = apiMessages.length;
        const beforeTokens = ContextManager.countTokens(JSON.stringify(apiMessages));

        await cm.compact();

        // The bug this guards against: injectSummary()/emergencyDrop() mutate
        // contextManager's own internal array (a different object from
        // this.apiMessages after _syncContext()'s spread-copy). Without
        // pulling that mutation back into this.apiMessages, apiMessages —
        // the array actually sent to the API and saved to disk — would stay
        // at its original size even while compact() reports a reduction.
        const afterCount = cm.getMessagesForSave().length;
        const afterTokens = ContextManager.countTokens(JSON.stringify(cm.getMessagesForSave()));

        assert.ok(summarizeCallCount > 0, 'test setup sanity: summarization should have actually run');
        assert.ok(afterCount < beforeCount,
            `apiMessages should shrink (was ${beforeCount}, now ${afterCount}) — a flat count means the reduction never left contextManager's private copy`);
        assert.ok(afterTokens < beforeTokens * 0.8,
            `apiMessages token count should drop meaningfully (was ~${beforeTokens}, now ~${afterTokens})`);
    });

    test('system message stays first through multiple summarization rounds', async () => {
        // Reproduces a live report: sending a message in a chat right after
        // compaction returned "System message must be at the beginning" from
        // the API — meaning apiMessages[0].role wasn't 'system' anymore.
        // summarizeCallCount > 1 here confirms this actually exercised
        // several rounds (the replace-vs-stack summary path included), not
        // just the first one.
        await cm.compact();

        const finalMessages = cm.getMessagesForSave();
        assert.ok(summarizeCallCount > 1, `test setup sanity: expected multiple summarization rounds, got ${summarizeCallCount}`);
        assert.strictEqual(finalMessages[0]?.role, 'system',
            `apiMessages[0] must stay the system message — got role '${finalMessages[0]?.role}' after ${summarizeCallCount} rounds`);
        const systemCount = finalMessages.filter(m => m.role === 'system').length;
        assert.ok(systemCount >= 1, 'at least one system message (prompt, + at most one summary) should remain');
    });

    test('system message stays first at real-world scale (~90K tokens, many rounds)', async () => {
        // Matches the reported scale directly: ~91K tokens down toward a 24K
        // target, several rounds of ~50 messages each. A smaller test above
        // already passes at 2-3 rounds — this rules out a bug that only
        // shows up after several rounds of summary replace-vs-stack cycles.
        apiMessages.length = 0;
        apiMessages.push({ role: 'system', content: 'You are a helpful assistant.' });
        for (let i = 0; i < 200; i++) {
            apiMessages.push(bigMessage(i % 2 === 0 ? 'user' : 'assistant', `turn${i}-`, 120));
        }
        contextManager.setApiMessages([...apiMessages]);

        const beforeTokens = ContextManager.countTokens(JSON.stringify(apiMessages));

        await cm.compact();

        const finalMessages = cm.getMessagesForSave();
        const afterTokens = ContextManager.countTokens(JSON.stringify(finalMessages));

        assert.ok(summarizeCallCount >= 3, `test setup sanity: expected several rounds at this scale, got ${summarizeCallCount} (before ~${beforeTokens} tokens)`);
        assert.ok(afterTokens < beforeTokens * 0.5,
            `should have made real progress at this scale (before ~${beforeTokens}, after ~${afterTokens})`);
        assert.strictEqual(finalMessages[0]?.role, 'system',
            `apiMessages[0] must stay the system message — got role '${finalMessages[0]?.role}' after ${summarizeCallCount} rounds`);

        // Every tool_call in the final array must have its matching tool
        // result also present — a broken pair is the other way this exact
        // "System message must be at the beginning"-style 400 shows up
        // (LLM APIs reject unmatched tool_call_id references too).
        const toolCallIds = new Set<string>();
        for (const m of finalMessages) {
            if (m.role === 'assistant' && m.tool_calls) {
                for (const tc of m.tool_calls) toolCallIds.add(tc.id);
            }
        }
        const toolResultIds = new Set(finalMessages.filter(m => m.role === 'tool' && m.tool_call_id).map(m => m.tool_call_id));
        for (const id of toolCallIds) {
            assert.ok(toolResultIds.has(id), `tool_call '${id}' has no matching tool result in the final message array`);
        }
    });

    test('system message and tool-call pairing survive compaction on a realistic tool-heavy chat', async () => {
        // The previous scale test used plain text messages and passed — but
        // this is a coding assistant; a real chat is dominated by
        // user -> assistant(tool_calls) -> tool(result) turns. This is the
        // scenario the two PRE-EXISTING failing tests
        // (getMessagesToSummarize's "never orphans tool-call pairs" and
        // injectSummary's "replaces existing summary instead of stacking")
        // are actually about — reproduce it directly against compact()
        // end-to-end rather than trusting those two unit tests are merely
        // test-authoring bugs.
        apiMessages.length = 0;
        apiMessages.push({ role: 'system', content: 'You are a helpful coding assistant.' });
        for (let i = 0; i < 60; i++) {
            apiMessages.push(...toolCallTurn(i, 200));
        }
        contextManager.setApiMessages([...apiMessages]);

        const beforeTokens = ContextManager.countTokens(JSON.stringify(apiMessages));

        await cm.compact();

        const finalMessages = cm.getMessagesForSave();
        const afterTokens = ContextManager.countTokens(JSON.stringify(finalMessages));

        assert.ok(summarizeCallCount >= 2, `test setup sanity: expected multiple rounds, got ${summarizeCallCount} (before ~${beforeTokens} tokens)`);
        assert.ok(afterTokens < beforeTokens,
            `should have made progress (before ~${beforeTokens}, after ~${afterTokens})`);
        assert.strictEqual(finalMessages[0]?.role, 'system',
            `apiMessages[0] must stay the system message — got role '${finalMessages[0]?.role}' after ${summarizeCallCount} rounds on tool-heavy content`);

        const toolCallIds = new Set<string>();
        for (const m of finalMessages) {
            if (m.role === 'assistant' && m.tool_calls) {
                for (const tc of m.tool_calls) toolCallIds.add(tc.id);
            }
        }
        const toolResultIds = new Set(finalMessages.filter(m => m.role === 'tool' && m.tool_call_id).map(m => m.tool_call_id));
        for (const id of toolCallIds) {
            assert.ok(toolResultIds.has(id), `tool_call '${id}' has no matching tool result — an orphaned tool_call is exactly what "System message must be at the beginning"-adjacent 400s look like from the API's perspective`);
        }
        // The reverse direction too: every tool result's tool_call_id must
        // reference an assistant message that's actually present.
        for (const m of finalMessages) {
            if (m.role === 'tool' && m.tool_call_id) {
                assert.ok(toolCallIds.has(m.tool_call_id), `orphaned tool result references tool_call_id '${m.tool_call_id}' with no matching assistant tool_call in the final array`);
            }
        }
    });

    test('compactDone\'s reported afterTokens matches what apiMessages actually contains', async () => {
        await cm.compact();

        const compactDone = posted.find(m => m.command === 'compactDone');
        assert.ok(compactDone, 'compactDone should have been posted');

        const reportedAfter = Number(compactDone!.afterTokens);
        const actualAfter = ContextManager.countTokens(JSON.stringify(cm.getMessagesForSave()));

        // Loose tolerance (role-prefix/tool_call overhead differs slightly
        // between getContextSize()'s accounting and a raw JSON.stringify
        // token count) — the point is these must be in the same ballpark,
        // not that compactDone reports a good number for a chat that
        // secretly stayed bloated.
        assert.ok(Math.abs(reportedAfter - actualAfter) < actualAfter * 0.5 + 500,
            `reported afterTokens (${reportedAfter}) should reflect apiMessages' real size (~${actualAfter}), not a number only true for contextManager's internal copy`);
    });

    test('the saved chat on disk reflects the reduction, not the pre-compact size', async () => {
        const beforeCount = apiMessages.length;

        await cm.compact();

        const saved = chatStore.getChat(chatId);
        assert.ok(saved, 'chat should have been saved');
        assert.ok(saved!.messages.length < beforeCount,
            `saved chat should have fewer messages than the pre-compact count (${beforeCount}), got ${saved!.messages.length}`);
    });

    test('does nothing (and says so) when already under the compact target', async () => {
        // A small conversation, already well under any reasonable target.
        const smallMessages: ChatCompletionMessage[] = [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
        ];
        apiMessages.length = 0;
        apiMessages.push(...smallMessages);
        contextManager.setApiMessages([...apiMessages]);

        await cm.compact();

        const compactDone = posted.find(m => m.command === 'compactDone');
        assert.ok(compactDone, 'compactDone should have been posted');
        assert.strictEqual(compactDone!.alreadyUnderTarget, true);
        assert.strictEqual(summarizeCallCount, 0, 'should not have called the summarization API at all');
        assert.strictEqual(cm.getMessagesForSave().length, smallMessages.length, 'nothing should have been removed');
    });
});
