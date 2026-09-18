import * as assert from 'assert';
import { ApiClient } from '../../api/apiClient';
import { buildFimPrompt } from '../../api/promptBuilder';

suite('Autocomplete Pipeline Tests', () => {

    suite('FIM prompt building', () => {
        test('returns prefix only when suffix is empty', () => {
            const prompt = buildFimPrompt('const x = 1;', '');
            assert.strictEqual(prompt, 'const x = 1;');
        });

        test('returns prefix + suffix separated by newline', () => {
            const prompt = buildFimPrompt('const x = 1;', 'console.log(x);');
            assert.strictEqual(prompt, 'const x = 1;\nconsole.log(x);');
        });

        test('strips trailing whitespace from prefix', () => {
            const prompt = buildFimPrompt('const x = 1;   \n  ', 'console.log(x);');
            assert.strictEqual(prompt, 'const x = 1;\nconsole.log(x);');
        });

        test('strips leading whitespace from suffix', () => {
            const prompt = buildFimPrompt('const x = 1;', '\n\n  console.log(x);');
            assert.strictEqual(prompt, 'const x = 1;\nconsole.log(x);');
        });

        test('handles multi-line prefix and suffix', () => {
            const prefix = 'function foo() {\n  const a = 1;\n';
            const suffix = '  return a;\n}';
            const prompt = buildFimPrompt(prefix, suffix);
            assert.ok(prompt.includes('function foo()'));
            assert.ok(prompt.includes('return a;'));
        });

        test('returns empty string for empty input', () => {
            const prompt = buildFimPrompt('', '');
            assert.strictEqual(prompt, '');
        });

        test('handles prefix-only (no suffix)', () => {
            const prompt = buildFimPrompt('console.log(', '');
            assert.strictEqual(prompt, 'console.log(');
        });
    });

    suite('sendCompletionRequest error handling', () => {
        test('throws when API key is missing', async () => {
            const noKey = new ApiClient({
                modelEndpoint: 'https://example.com',
                modelName: 'test',
                apiKey: '',
                contextWindowSize: 8192,
                defaultMode: 'build',
                openCodeEnabled: false,
                temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5, repetitionPenalty: 1.0, minP: 0.0,
            });

            await assert.rejects(
                noKey.sendCompletionRequest('prefix', 'suffix'),
                /API key is not configured/
            );
        });

        test('returns empty string on network failure (no throw)', async () => {
            const badClient = new ApiClient({
                modelEndpoint: 'http://localhost:99999',
                modelName: 'test',
                apiKey: 'key',
                contextWindowSize: 8192,
                defaultMode: 'build',
                openCodeEnabled: false,
                temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5, repetitionPenalty: 1.0, minP: 0.0,
            });

            // Should not throw — autocomplete silently fails on network errors
            const result = await badClient.sendCompletionRequest('x = ', '');
            assert.strictEqual(result, '');
        });
    });
});
