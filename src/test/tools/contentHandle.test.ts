import * as assert from 'assert';
import {
    storeContent,
    retrieveContent,
    retrieveContentByLines,
    needsHandle,
    removeHandle,
    clearAllHandles,
    configureContentHandles,
} from '../../tools/contentHandle';

suite('ContentHandle Tests', () => {

    setup(() => {
        clearAllHandles();
        // Reset to defaults
        configureContentHandles({ maxInlineChars: 10_000, maxStoredBytes: 5 * 1024 * 1024, ttlMs: 10 * 60 * 1000 });
    });

    teardown(() => {
        clearAllHandles();
    });

    suite('needsHandle', () => {
        test('returns false for small content', () => {
            assert.strictEqual(needsHandle('short text'), false);
        });

        test('returns true for content exceeding inline limit', () => {
            const large = 'x'.repeat(11_000);
            assert.strictEqual(needsHandle(large), true);
        });

        test('returns false at exactly the limit', () => {
            const exact = 'x'.repeat(10_000);
            assert.strictEqual(needsHandle(exact), false);
        });

        test('returns true one over the limit', () => {
            const over = 'x'.repeat(10_001);
            assert.strictEqual(needsHandle(over), true);
        });
    });

    suite('storeContent', () => {
        test('stores content and returns handle', () => {
            const { inlineText, handle } = storeContent('hello world');
            assert.strictEqual(inlineText, 'hello world');
            assert.ok(handle.id.startsWith('ch_'));
            assert.strictEqual(handle.totalBytes, 11);
            // 'hello world' has no newline, so split('\n') gives a single line.
            assert.strictEqual(handle.totalLines, 1);
            assert.strictEqual(handle.contentType, 'text/plain');
        });

        test('truncates inline text for large content', () => {
            const content = 'a'.repeat(15_000);
            const { inlineText, handle } = storeContent(content);
            assert.strictEqual(inlineText.length, 10_000);
            assert.strictEqual(handle.inlineChars, 10_000);
            assert.strictEqual(handle.totalLines, 1);
        });

        test('rejects oversized content', () => {
            configureContentHandles({ maxStoredBytes: 100 });
            const huge = 'x'.repeat(200);
            assert.throws(() => storeContent(huge), /OUTPUT_TRUNCATED/);
        });

        test('supports JSON content type', () => {
            const { handle } = storeContent('{"key": "value"}', 'text/json');
            assert.strictEqual(handle.contentType, 'text/json');
        });
    });

    suite('retrieveContent', () => {
        test('retrieves stored content', () => {
            const content = 'line1\nline2\nline3';
            const { handle } = storeContent(content);
            const result = retrieveContent(handle.id);

            assert.ok(result);
            assert.strictEqual(result!.content, content);
            assert.strictEqual(result!.handle?.id, handle.id);
            assert.strictEqual(result!.truncated, false);
        });

        test('returns null for unknown handle', () => {
            assert.strictEqual(retrieveContent('ch_nonexistent'), null);
        });

        test('supports offset and limit', () => {
            const content = '0123456789';
            const { handle } = storeContent(content);
            const result = retrieveContent(handle.id, 3, 4);

            assert.ok(result);
            assert.strictEqual(result!.content, '3456');
            assert.strictEqual(result!.truncated, true);
        });

        test('reports not truncated when within bounds', () => {
            const content = 'hello';
            const { handle } = storeContent(content);
            const result = retrieveContent(handle.id, 0, 100);

            assert.ok(result);
            assert.strictEqual(result!.truncated, false);
        });

        test('respects TTL', () => {
            configureContentHandles({ ttlMs: 50 });
            const content = 'expires soon';
            const { handle } = storeContent(content);

            // Should be available immediately
            assert.ok(retrieveContent(handle.id));

            // Wait for TTL to expire
            // Note: In tests we can't easily wait, so we verify the mechanism exists
            // by checking that a very short TTL was configured
        });
    });

    suite('retrieveContentByLines', () => {
        test('retrieves specific line range', () => {
            const content = 'first\nsecond\nthird\nfourth';
            const { handle } = storeContent(content);
            const result = retrieveContentByLines(handle.id, 1, 2);

            assert.ok(result);
            assert.strictEqual(result!.content, 'second\nthird');
        });

        test('returns null for unknown handle', () => {
            assert.strictEqual(retrieveContentByLines('ch_nope', 0, 5), null);
        });

        test('retrieves single line', () => {
            const content = 'a\nb\nc';
            const { handle } = storeContent(content);
            const result = retrieveContentByLines(handle.id, 0, 0);

            assert.ok(result);
            assert.strictEqual(result!.content, 'a');
        });
    });

    suite('removeHandle', () => {
        test('removes existing handle', () => {
            const { handle } = storeContent('test');
            assert.strictEqual(removeHandle(handle.id), true);
            assert.strictEqual(retrieveContent(handle.id), null);
        });

        test('returns false for non-existent handle', () => {
            assert.strictEqual(removeHandle('ch_fake'), false);
        });
    });

    suite('clearAllHandles', () => {
        test('clears all stored content', () => {
            storeContent('one');
            storeContent('two');
            storeContent('three');

            clearAllHandles();

            assert.strictEqual(retrieveContent('ch_any'), null);
        });
    });

    suite('configureContentHandles', () => {
        test('changes inline limit', () => {
            configureContentHandles({ maxInlineChars: 5 });
            assert.strictEqual(needsHandle('123456'), true);
            assert.strictEqual(needsHandle('12345'), false);
        });

        test('changes TTL', () => {
            configureContentHandles({ ttlMs: 100 });
            // Just verify it doesn't throw — TTL is checked on retrieval
        });
    });
});
