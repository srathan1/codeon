import * as assert from 'assert';
import { ApiClient } from '../../api/apiClient';
import { ChatConfig } from '../../types';

/**
 * P5-T14: coverage for readSSEStream — the hand-rolled SSE parser that was
 * previously untested. Exercises the failure-prone parts directly:
 *   - a JSON object split across two chunk boundaries (partial-line buffering)
 *   - tool-call argument deltas concatenated across many chunks
 *   - a tool-call whose `id` only arrives on a later delta
 *   - a malformed `data:` line that must be skipped without killing the stream
 *
 * readSSEStream is private; we reach it via a cast. We feed it a hand-built
 * Response whose body is a ReadableStream of UTF-8 chunks, so no network or
 * real fetch is involved.
 */

const TEST_CONFIG: ChatConfig = {
    modelEndpoint: 'http://localhost',
    modelName: 'test-model',
    apiKey: 'test-key',
    temperature: 0,
    topP: 1,
    topK: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    minP: 0,
    maxTokens: 1000,
    contextWindowSize: 8000,
    openCodeEnabled: true,
    defaultMode: 'build',
} as unknown as ChatConfig;

/** Build a Response whose body streams the given string chunks as UTF-8. */
function responseFromChunks(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
        },
    });
    // Minimal shape used by readSSEStream: .body.getReader()
    return { body: stream, ok: true, status: 200 } as unknown as Response;
}

/** Invoke the private readSSEStream with a no-op (or capturing) onChunk. */
async function runParser(chunks: string[], onChunk: (s: string) => void = () => {}) {
    const client = new ApiClient(TEST_CONFIG);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching a private method under test
    return (client as any).readSSEStream(responseFromChunks(chunks), onChunk);
}

suite('SSE stream parser (P5-T14)', () => {
    test('reassembles a JSON object split across two chunk boundaries', async () => {
        // The `data:` line for a content delta is split mid-JSON across two reads.
        const line = 'data: {"choices":[{"delta":{"content":"hello world"}}]}\n';
        const mid = Math.floor(line.length / 2);
        const captured: string[] = [];
        const result = await runParser([line.slice(0, mid), line.slice(mid)], (c) => captured.push(c));

        assert.strictEqual(result.content, 'hello world', 'split JSON should be buffered and parsed as one delta');
        assert.deepStrictEqual(captured, ['hello world']);
    });

    test('concatenates content deltas arriving in separate chunks', async () => {
        const chunks = [
            'data: {"choices":[{"delta":{"content":"foo"}}]}\n',
            'data: {"choices":[{"delta":{"content":"bar"}}]}\n',
            'data: [DONE]\n',
        ];
        const result = await runParser(chunks);
        assert.strictEqual(result.content, 'foobar');
    });

    test('reconstructs tool-call arguments streamed as incremental deltas', async () => {
        // Arguments '{"path":"a.txt"}' arrive in three pieces across chunks;
        // id + name come on the first delta only.
        const chunks = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a."}}]}}]}\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"txt\\"}"}}]}}]}\n',
            'data: [DONE]\n',
        ];
        const result = await runParser(chunks);
        assert.ok(result.nativeToolCalls, 'expected native tool calls');
        assert.strictEqual(result.nativeToolCalls.length, 1);
        const tc = result.nativeToolCalls[0];
        assert.strictEqual(tc.id, 'call_1');
        assert.strictEqual(tc.function.name, 'read_file');
        assert.deepStrictEqual(JSON.parse(tc.function.arguments), { path: 'a.txt' });
    });

    test('keeps a tool call whose id only arrives on a later delta', async () => {
        // First delta for index 0 has NO id; a later delta supplies it.
        const chunks = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"glob_files","arguments":"{}"}}]}}]}\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_late"}]}}]}\n',
            'data: [DONE]\n',
        ];
        const result = await runParser(chunks);
        assert.strictEqual(result.nativeToolCalls.length, 1, 'the tool call must survive even though its id arrived late');
        assert.strictEqual(result.nativeToolCalls[0].id, 'call_late');
    });

    test('skips a malformed data: line without killing the stream', async () => {
        const chunks = [
            'data: {"choices":[{"delta":{"content":"before"}}]}\n',
            'data: {this is not valid json}\n',
            'data: {"choices":[{"delta":{"content":"after"}}]}\n',
            'data: [DONE]\n',
        ];
        const result = await runParser(chunks);
        assert.strictEqual(result.content, 'beforeafter', 'a malformed frame must be dropped, not abort the whole parse');
    });
});
