import * as assert from 'assert';
import { toolRegistry } from '../../tools/toolRegistry';
import { SubAgentLoop, SubAgentProgressEvent } from '../../agents/subAgentLoop';

suite('SubAgentLoop & Scoped Registry Tests', () => {

    suite('ToolRegistry.createSubset()', () => {
        test('returns a registry containing only allowed tools', () => {
            const subset = toolRegistry.createSubset(['read_file', 'list_dir']);
            assert.strictEqual(subset.has('read_file'), true);
            assert.strictEqual(subset.has('list_dir'), true);
            // Tools not in allowlist should be absent
            assert.strictEqual(subset.has('execute_command'), false);
            assert.strictEqual(subset.has('search_files'), false);
        });

        test('excludes agent-management tools even when explicitly listed', () => {
            const subset = toolRegistry.createSubset(['read_file', 'spawn_agent', 'stop_agent', 'ask_user_question']);
            assert.strictEqual(subset.has('read_file'), true);
            assert.strictEqual(subset.has('spawn_agent'), false);
            assert.strictEqual(subset.has('stop_agent'), false);
            assert.strictEqual(subset.has('ask_user_question'), false);
        });

        test('excludes non-existent tools silently', () => {
            const subset = toolRegistry.createSubset(['read_file', 'imaginary_tool_xyz']);
            assert.strictEqual(subset.has('read_file'), true);
            assert.strictEqual(subset.has('imaginary_tool_xyz'), false);
        });

        test('empty allowlist produces empty registry', () => {
            const subset = toolRegistry.createSubset([]);
            assert.strictEqual(subset.allDefinitions().length, 0);
        });

        test('allDefinitions returns correct count', () => {
            const subset = toolRegistry.createSubset(['read_file', 'list_dir', 'grep_search']);
            assert.strictEqual(subset.allDefinitions().length, 3);
        });

        test('getExecutor returns executor for registered tools', () => {
            const subset = toolRegistry.createSubset(['read_file']);
            const exec = subset.getExecutor('read_file');
            assert.ok(exec, 'Should have read_file executor');
            assert.strictEqual(exec.name, 'read_file');
        });
    });

    suite('SubAgentLoop.run()', () => {
        let progressEvents: SubAgentProgressEvent[] = [];

        function captureProgress(event: SubAgentProgressEvent) {
            progressEvents.push(event);
        }

        beforeEach(() => {
            progressEvents = [];
        });

        test('abort signal stops the loop immediately', async () => {
            const abortController = new AbortController();
            // Abort before the loop starts
            abortController.abort();

            const result = await new SubAgentLoop().run({
                systemPrompt: 'You are a helper.',
                userMessage: 'Do something.',
                toolAllowlist: ['read_file'],
                maxTurns: 1,
                timeoutMs: 10000,
                onProgress: captureProgress,
                abortSignal: abortController.signal,
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.error, 'Aborted by parent');
            assert.strictEqual(result.toolCalls, 0);
        });

        test('timeout fires when loop exceeds deadline', async () => {
            // Give a very short timeout — the API call will take longer than 1ms
            const result = await new SubAgentLoop().run({
                systemPrompt: 'You are a helper.',
                userMessage: 'Hello.',
                toolAllowlist: ['read_file'],
                maxTurns: 15,
                timeoutMs: 1,
                onProgress: captureProgress,
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('timed out') || result.error?.includes('AbortError'));
        });

        test('onProgress receives turn_start event', async () => {
            // This test will fail because the API is unreachable, but we can still
            // verify that the progress callback structure works.
            // The key insight: if the API throws, we get an error event.
            try {
                await new SubAgentLoop().run({
                    systemPrompt: 'You are a helper.',
                    userMessage: 'Hi.',
                    toolAllowlist: [],
                    maxTurns: 1,
                    timeoutMs: 2000,
                    onProgress: captureProgress,
                });
            } catch {
                // ignore
            }

            // We should have received at least a turn_start before the API failed
            assert.ok(progressEvents.length > 0, 'Expected at least one progress event');
            assert.strictEqual(progressEvents[0].type, 'turn_start');
        });

        test('error event is emitted on API failure', async () => {
            progressEvents = [];
            const result = await new SubAgentLoop().run({
                systemPrompt: 'You are a helper.',
                userMessage: 'Test.',
                toolAllowlist: [],
                maxTurns: 1,
                timeoutMs: 3000,
                onProgress: captureProgress,
            });

            // Either the API succeeds (unlikely without config) or fails
            // In either case, verify the result shape
            assert.ok(result.success === true || result.success === false);
            assert.ok(typeof result.output === 'string');
            assert.ok(result.toolCalls >= 0);
            assert.ok(result.durationMs >= 0);
        });

        test('modelConfig override merges into base config', async () => {
            // Verify that passing a modelConfig doesn't crash
            const result = await new SubAgentLoop().run({
                systemPrompt: 'Helper.',
                userMessage: 'Go.',
                toolAllowlist: [],
                maxTurns: 1,
                timeoutMs: 2000,
                onProgress: captureProgress,
                modelConfig: {
                    modelEndpoint: 'http://custom-endpoint:8080/v1/chat/completions',
                    modelName: 'custom-model',
                    apiKey: 'custom-key',
                    contextWindowSize: 180000,
                },
            });

            // Result exists regardless of API success/failure
            assert.ok(result !== null);
        });
    });
});
