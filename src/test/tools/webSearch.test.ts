import * as assert from 'assert';
import { WebSearchExecutor } from '../../tools/executors/webSearch';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate DuckDuckGo-style HTML with the given number of `.result` divs. */
function generateDdgHtml(count: number): string {
    const results: string[] = [];
    for (let i = 0; i < count; i++) {
        results.push(
            `<div class="result">` +
                `<a class="result__a" href="https://example${i}.com/page">${encodeURIComponent(`Result Title ${i}`)}</a>` +
                `<a class="snippet">Snippet text for result number ${i}</a>` +
            `</div>`
        );
    }
    return `<html><body>${results.join('\n')}</body></html>`;
}

/** Generate a CAPTCHA / blocked DDG response. */
function generateCaptchaHtml(): string {
    return `<html><body><div id="captcha">DC:LABelframe — Just a moment… Enable JavaScript and cookies to continue</div></body></html>`;
}

/** Build a minimal Response-like object for mocking fetch. */
function mockResponse(opts: { ok: boolean; status: number; statusText?: string; body?: string }): Response {
    return {
        ok: opts.ok,
        status: opts.status,
        statusText: opts.statusText ?? '',
        headers: new Headers(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock Response body type is complex
        body: null as any,
        bodyUsed: false,
        redirected: false,
        type: 'basic' as ResponseType,
        url: '',
        clone: () => mockResponse(opts),
        arrayBuffer: async () => new ArrayBuffer(0),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        json: async () => ({}),
        text: async () => opts.body ?? '',
        bytes: async () => new Uint8Array(),
    };
}

/** Stub global fetch before each test and restore afterwards. */
let originalFetch: typeof globalThis.fetch;

function setupFetchMock(mockFn: typeof fetch): void {
    originalFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = mockFn;
}

function teardownFetchMock(): void {
    globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('WebSearchExecutor', () => {
    let executor: WebSearchExecutor;

    setup(() => {
        executor = new WebSearchExecutor();
    });

    suiteSetup(() => {
        // Ensure AbortController exists (Node 15+ has it globally)
        if (!globalThis.AbortController) {
            // Minimal stub so the executor doesn't crash in older runtimes
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- polyfilling globalThis for older runtimes
            (globalThis as any).AbortController = class {
                signal = {} as AbortSignal;
                abort() {}
            };
        }
    });

    teardown(() => {
        teardownFetchMock();
    });

    suite('name', () => {
        test('exposes correct tool name', () => {
            assert.strictEqual(executor.name, 'web_search');
        });
    });

    suite('missing / empty query', () => {
        test('returns error when query is missing', async () => {
            setupFetchMock(async () => { throw new Error('should not be called'); });
            const result = await executor.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_PARAMETER'));
            assert.ok(result.error?.includes('query'));
        });

        test('returns error when query is empty string', async () => {
            setupFetchMock(async () => { throw new Error('should not be called'); });
            const result = await executor.execute({ query: '' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_PARAMETER'));
        });

        test('returns error when query is only whitespace', async () => {
            setupFetchMock(async () => { throw new Error('should not be called'); });
            const result = await executor.execute({ query: '   ' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_PARAMETER'));
        });
    });

    suite('maxResults clamping', () => {
        test('defaults to 10 when maxResults is not provided', async () => {
            const html = generateDdgHtml(20);
            setupFetchMock(async () => mockResponse({ ok: true, status: 200, body: html }));
            const result = await executor.execute({ query: 'test' });
            assert.strictEqual(result.success, true);
            // Only 10 should appear in the formatted output lines
            const jsonMatch = result.output.match(/--- Raw JSON ---\s*([\s\S]*)$/);
            assert.ok(jsonMatch, 'Raw JSON block should be present');
            const parsed = JSON.parse(jsonMatch[1]);
            assert.strictEqual(parsed.length, 10);
        });

        test('clamps maxResults above 50 down to 50', async () => {
            const html = generateDdgHtml(60);
            setupFetchMock(async () => mockResponse({ ok: true, status: 200, body: html }));
            const result = await executor.execute({ query: 'test', maxResults: 999 });
            assert.strictEqual(result.success, true);
            const jsonMatch = result.output.match(/--- Raw JSON ---\s*([\s\S]*)$/);
            assert.ok(jsonMatch);
            const parsed = JSON.parse(jsonMatch[1]);
            assert.ok(parsed.length <= 50, `expected ≤ 50 results, got ${parsed.length}`);
        });

        test('accepts a valid custom maxResults below 50', async () => {
            const html = generateDdgHtml(30);
            setupFetchMock(async () => mockResponse({ ok: true, status: 200, body: html }));
            const result = await executor.execute({ query: 'test', maxResults: 5 });
            assert.strictEqual(result.success, true);
            const jsonMatch = result.output.match(/--- Raw JSON ---\s*([\s\S]*)$/);
            assert.ok(jsonMatch);
            const parsed = JSON.parse(jsonMatch[1]);
            assert.ok(parsed.length <= 5, `expected ≤ 5 results, got ${parsed.length}`);
        });

        test('falls back to default when maxResults is not an integer', async () => {
            const html = generateDdgHtml(20);
            setupFetchMock(async () => mockResponse({ ok: true, status: 200, body: html }));
            const result = await executor.execute({ query: 'test', maxResults: 3.14 });
            assert.strictEqual(result.success, true);
            const jsonMatch = result.output.match(/--- Raw JSON ---\s*([\s\S]*)$/);
            assert.ok(jsonMatch);
            const parsed = JSON.parse(jsonMatch[1]);
            assert.ok(parsed.length <= 10, `expected ≤ 10 (default), got ${parsed.length}`);
        });
    });

    suite('HTML parsing', () => {
        test('parses .result divs with title, URL, and snippet', async () => {
            const html = generateDdgHtml(3);
            setupFetchMock(async () => mockResponse({ ok: true, status: 200, body: html }));
            const result = await executor.execute({ query: 'hello world' });
            assert.strictEqual(result.success, true);
            const jsonMatch = result.output.match(/--- Raw JSON ---\s*([\s\S]*)$/);
            assert.ok(jsonMatch, 'output should contain raw JSON block');
            const parsed: Array<{ title: string; url: string; snippet: string }> = JSON.parse(jsonMatch[1]);
            assert.strictEqual(parsed.length, 3);
            assert.ok(parsed[0].url.includes('example0.com'));
            assert.ok(parsed[0].snippet.includes('Snippet text'));
        });

        test('handles zero results in HTML', async () => {
            setupFetchMock(async () => mockResponse({ ok: true, status: 200, body: '<html><body></body></html>' }));
            const result = await executor.execute({ query: 'xyznonexistent' });
            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('No results found'));
            assert.ok(result.output.includes('xyznonexistent'));
        });
    });

    suite('CAPTCHA / blocked detection', () => {
        test('returns helpful error when DDG returns CAPTCHA page', async () => {
            setupFetchMock(async () => mockResponse({ ok: true, status: 200, body: generateCaptchaHtml() }));
            const result = await executor.execute({ query: 'test' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SEARCH_FAILED'), `error: ${result.error}`);
            assert.ok(result.error?.includes('DuckDuckGo blocked'), `error: ${result.error}`);
            assert.ok(result.error?.includes('rate limiting') || result.error?.includes('CAPTCHA'), `error: ${result.error}`);
        });
    });

    suite('HTTP error handling', () => {
        test('returns rate-limit message on HTTP 429', async () => {
            setupFetchMock(async () => mockResponse({ ok: false, status: 429, statusText: 'Too Many Requests' }));
            const result = await executor.execute({ query: 'test' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('Rate limited'), `error: ${result.error}`);
        });

        test('returns generic search-failed message on other HTTP errors', async () => {
            setupFetchMock(async () => mockResponse({ ok: false, status: 500, statusText: 'Internal Server Error' }));
            const result = await executor.execute({ query: 'test' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SEARCH_FAILED'), `error: ${result.error}`);
        });
    });

    suite('no results found', () => {
        test('returns friendly message when no results match', async () => {
            setupFetchMock(async () => mockResponse({ ok: true, status: 200, body: '<html><body><p>No matches</p></body></html>' }));
            const result = await executor.execute({ query: 'obscure topic' });
            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('No results found'));
            assert.ok(result.output.includes('obscure topic'));
            assert.ok(result.output.includes('Tip:') || result.output.includes('rephrasing'));
        });
    });

    suite('raw JSON block', () => {
        test('includes raw JSON at the end of output on success', async () => {
            const html = generateDdgHtml(2);
            setupFetchMock(async () => mockResponse({ ok: true, status: 200, body: html }));
            const result = await executor.execute({ query: 'json check' });
            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('--- Raw JSON ---'), 'should contain JSON separator');
            // Verify the JSON is actually parseable
            const jsonMatch = result.output.match(/--- Raw JSON ---\s*([\s\S]*)$/);
            assert.ok(jsonMatch, 'JSON block should be at the end');
            const parsed = JSON.parse(jsonMatch[1]);
            assert.ok(Array.isArray(parsed));
            assert.ok(parsed.length >= 1);
        });
    });

    suite('fetch throws', () => {
        test('catches network errors and returns SEARCH_FAILED', async () => {
            setupFetchMock(async () => {
                throw new Error('network disabled');
            });
            const result = await executor.execute({ query: 'test' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SEARCH_FAILED'), `error: ${result.error}`);
        });
    });
});
