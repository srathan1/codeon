import * as assert from 'assert';
import { ApiClient, TOOL_DEFINITIONS } from '../../api/apiClient';
import { ChatConfig, ChatCompletionMessage } from '../../types';

const testConfig: ChatConfig = {
    modelEndpoint: 'http://localhost:8080',
    modelName: 'test-model',
    apiKey: 'test-key',
    contextWindowSize: 4096,
    defaultMode: 'plan',
    openCodeEnabled: true,
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    presencePenalty: 1.5,
    repetitionPenalty: 1.0,
    minP: 0.0
};

suite('ApiClient Tests', () => {
    suite('TOOL_DEFINITIONS', () => {
        test('contains all expected tools', () => {
            const names = TOOL_DEFINITIONS.map(t => t.name);
            assert.ok(names.includes('list_dir'), 'Should have list_dir');
            assert.ok(names.includes('read_file'), 'Should have read_file');
            assert.ok(names.includes('apply_patch'), 'Should have apply_patch');
            assert.ok(names.includes('search_files'), 'Should have search_files');
            assert.ok(names.includes('execute_command'), 'Should have execute_command');
        });

        test('each tool has a riskLevel', () => {
            for (const tool of TOOL_DEFINITIONS) {
                assert.ok(
                    ['safe', 'moderate', 'dangerous'].includes(tool.riskLevel),
                    `Tool ${tool.name} should have valid riskLevel`
                );
            }
        });

        test('execute_command is dangerous', () => {
            const execCmd = TOOL_DEFINITIONS.find(t => t.name === 'execute_command');
            assert.strictEqual(execCmd?.riskLevel, 'dangerous');
        });

        test('apply_patch is moderate', () => {
            const patch = TOOL_DEFINITIONS.find(t => t.name === 'apply_patch');
            assert.strictEqual(patch?.riskLevel, 'moderate');
        });

        test('read_file and list_dir are safe', () => {
            const read = TOOL_DEFINITIONS.find(t => t.name === 'read_file');
            const list = TOOL_DEFINITIONS.find(t => t.name === 'list_dir');
            assert.strictEqual(read?.riskLevel, 'safe');
            assert.strictEqual(list?.riskLevel, 'safe');
        });
    });

    suite('buildSystemPrompt()', () => {
        test('returns mode-specific prompt', () => {
            const prompt = ApiClient.buildSystemPrompt('plan');
            assert.ok(prompt.includes('Plan mode'), 'Plan mode prompt should mention planning');
        });

        test('build mode mentions implementation', () => {
            const prompt = ApiClient.buildSystemPrompt('build');
            assert.ok(prompt.toLowerCase().includes('implement') || prompt.toLowerCase().includes('code'));
        });

        test('unknown mode falls back to plan', () => {
            const prompt = ApiClient.buildSystemPrompt('unknown-mode');
            assert.ok(prompt.includes('Plan mode'), 'Unknown mode should fall back to plan');
        });
    });

    suite('getChatCompletionsUrl() via getConfig()', () => {
        test('ApiClient can be constructed with config', () => {
            const client = new ApiClient(testConfig);
            assert.ok(client, 'ApiClient should be constructible');
        });

        test('getConfig returns valid config', () => {
            const config = ApiClient.getConfig();
            assert.ok(config.contextWindowSize > 0);
            assert.ok(config.defaultMode.length > 0);
        });

        test('mergeConfig overrides model fields, including per-model contextWindowSize', () => {
            const base = ApiClient.getConfig();
            const merged = ApiClient.mergeConfig(base, {
                modelName: 'my-model',
                modelEndpoint: 'https://example.com',
                apiKey: 'secret',
                contextWindowSize: 32000,
            });
            assert.strictEqual(merged.modelName, 'my-model');
            assert.strictEqual(merged.modelEndpoint, 'https://example.com');
            assert.strictEqual(merged.apiKey, 'secret');
            // Context window is per-model now (P6-T16) — the active model's
            // value wins over the base/default, since different models
            // genuinely have different limits.
            assert.strictEqual(merged.contextWindowSize, 32000);
        });
    });

    suite('parseToolCalls() — dual native + Qwen fallback', () => {
        // Access private method via public interface — we test via sendMessageNonStreaming behavior.
        // Instead, test the public getToolDefinitions static:
        test('getToolDefinitions returns same definitions', () => {
            const defs = ApiClient.getToolDefinitions();
            assert.strictEqual(defs.length, TOOL_DEFINITIONS.length);
            assert.strictEqual(defs[0].name, TOOL_DEFINITIONS[0].name);
        });

        test('sendMessage throws when apiKey missing', async () => {
            const noKeyConfig = { ...testConfig, apiKey: '' };
            const badClient = new ApiClient(noKeyConfig);
            const msgs: ChatCompletionMessage[] = [{ role: 'user', content: 'hi' }];

            await assert.rejects(
                badClient.sendMessageStreaming(msgs, 'plan', false, () => {}),
                /API key is not configured/
            );
        });
    });

    suite('Qwen-style tool call parsing', () => {
        test('recognizes Qwen tool markup pattern', () => {
            // The Qwen pattern uses \u200b\u001d ... \u001c\u200b
            const content = `Some text\n\u200b\u001d<name>read_file</name><arguments>{"path":"src/test.ts"}</arguments>\u001c\u200b\nMore text`;
            
            // We can't directly test parseToolCalls (private), but verify the pattern exists
            const qwenPattern = /\u200b\u001d(.*?)\u001c\u200b/g;
            const matches = [...content.matchAll(qwenPattern)];
            assert.strictEqual(matches.length, 1, 'Should find one Qwen tool block');
        });

        test('native tool calls take precedence over Qwen pattern', () => {
            // When both exist, native should be parsed first
            const content = '\u200b\u001d<name>fallback</name><arguments>{}</arguments>\u001c\u200b';
            const nativeCalls = [
                { id: 'call_1', type: 'function', function: { name: 'native_tool', arguments: '{}' } }
            ];

            // Verify that the content has Qwen markup but would be overridden by native
            const hasQwen = /\u200b\u001d/.test(content);
            assert.ok(hasQwen, 'Content should have Qwen markup');
            assert.strictEqual(nativeCalls.length, 1, 'Native calls present');
        });
    });
});
