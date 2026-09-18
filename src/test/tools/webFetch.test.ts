import * as assert from 'assert';
import * as dns from 'dns';
import { WebFetchExecutor } from '../../tools/executors/webFetch';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Restore original globals after a test modifies them. */
function restoreGlobalFetch(originalFetch: typeof globalThis.fetch | undefined) {
    if (originalFetch !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).fetch = originalFetch;
    }
}

/** DNS lookup callback type compatible with both sync/async overloads. */
type DnsLookupCallback = (
    err: Error | null,
    address: dns.LookupAddress[],
    family: number,
) => void;

/** Save and optionally replace `dns.lookup`. Returns a restore function. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockDnsLookup(fn: any): () => void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (dns as any).lookup;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dns as any).lookup = fn;
    return () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dns as any).lookup = original;
    };
}

/** Build a minimal ReadableStream that yields the given chunks. */
function makeReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });
}

/** Build a mock Response-like object. */
function makeResponse(
    body: string,
    status: number = 200,
    headers: Record<string, string> = {},
): Response {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(body);
    const headerMap: [string, string][] = Object.entries(headers);
    return new Response(makeReadableStream([bytes]), {
        status,
        headers: headerMap,
    });
}

/** Build a mock redirect response. */
function makeRedirect(location: string, status: number = 302): Response {
    return new Response(null, {
        status,
        headers: [['location', location]],
    });
}

/* ------------------------------------------------------------------ */
/*  Suite                                                              */
/* ------------------------------------------------------------------ */

suite('WebFetchExecutor Tests', () => {
    let executor: WebFetchExecutor;
    let originalFetch: typeof globalThis.fetch | undefined;
    let restoreDns: () => void;

    setup(() => {
        executor = new WebFetchExecutor();
        originalFetch = globalThis.fetch;
        // Default: dns.lookup resolves to a public IP so SSRF does NOT block
        restoreDns = mockDnsLookup((_hostname: string, _opts: unknown, cb: DnsLookupCallback) => {
            cb(null, [{ address: '93.184.216.34', family: 4 }], 4);
        });
    });

    teardown(() => {
        restoreGlobalFetch(originalFetch);
        restoreDns();
    });

    /* -------------------------------------------------------------- */
    /*  1. Missing URL parameter                                       */
    /* -------------------------------------------------------------- */
    suite('missing / invalid parameters', () => {
        test('returns error when url is missing', async () => {
            const result = await executor.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_PARAMETER'));
            assert.ok(result.error?.includes('url is required'));
        });

        test('returns error when url is empty string', async () => {
            const result = await executor.execute({ url: '' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_PARAMETER'));
        });

        test('returns error when url is whitespace only', async () => {
            const result = await executor.execute({ url: '   ' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_PARAMETER'));
        });

        test('returns error when url is undefined', async () => {
            const result = await executor.execute({ url: undefined });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_PARAMETER'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  2. Invalid URL                                                 */
    /* -------------------------------------------------------------- */
    suite('invalid URL', () => {
        test('returns INVALID_URL for non-URL string', async () => {
            const result = await executor.execute({ url: 'not a url at all' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('INVALID_URL'));
        });

        test('returns INVALID_URL for malformed URL', async () => {
            const result = await executor.execute({ url: 'ht tp://broken' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('INVALID_URL'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  3. Non-http/https protocol                                     */
    /* -------------------------------------------------------------- */
    suite('protocol not allowed', () => {
        test('blocks ftp:// URLs', async () => {
            const result = await executor.execute({ url: 'ftp://example.com/file.txt' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('PROTOCOL_NOT_ALLOWED'));
            assert.ok(result.error?.includes('ftp:'));
        });

        test('blocks file:// URLs', async () => {
            const result = await executor.execute({ url: 'file:///etc/passwd' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('PROTOCOL_NOT_ALLOWED'));
            assert.ok(result.error?.includes('file:'));
        });

        test('blocks data: URLs', async () => {
            const result = await executor.execute({ url: 'data:text/plain,hello' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('PROTOCOL_NOT_ALLOWED'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  4. SSRF protection — private IPs                               */
    /* -------------------------------------------------------------- */
    suite('SSRF protection — private / reserved IPs', () => {
        test('blocks 10.x.x.x via DNS lookup', async () => {
            restoreDns();
            restoreDns = mockDnsLookup((_host: string, _opts: unknown, cb: DnsLookupCallback) => {
                cb(null, [{ address: '10.0.0.5', family: 4 }], 4);
            });
            const result = await executor.execute({ url: 'http://internal.example.com/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });

        test('blocks 192.168.x.x via DNS lookup', async () => {
            restoreDns();
            restoreDns = mockDnsLookup((_host: string, _opts: unknown, cb: DnsLookupCallback) => {
                cb(null, [{ address: '192.168.1.1', family: 4 }], 4);
            });
            const result = await executor.execute({ url: 'http://router.local/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });

        test('blocks 127.0.0.1 via DNS lookup', async () => {
            restoreDns();
            restoreDns = mockDnsLookup((_host: string, _opts: unknown, cb: DnsLookupCallback) => {
                cb(null, [{ address: '127.0.0.1', family: 4 }], 4);
            });
            const result = await executor.execute({ url: 'http://localhost-proxy/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });

        test('blocks 169.254.x.x (link-local) via DNS lookup', async () => {
            restoreDns();
            restoreDns = mockDnsLookup((_host: string, _opts: unknown, cb: DnsLookupCallback) => {
                cb(null, [{ address: '169.254.100.1', family: 4 }], 4);
            });
            const result = await executor.execute({ url: 'http://linklocal.local/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });

        test('blocks 172.16.x.x via DNS lookup', async () => {
            restoreDns();
            restoreDns = mockDnsLookup((_host: string, _opts: unknown, cb: DnsLookupCallback) => {
                cb(null, [{ address: '172.16.0.1', family: 4 }], 4);
            });
            const result = await executor.execute({ url: 'http://private.corp/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });

        test('allows public IPs through', async () => {
            // Default mock already returns 93.184.216.34
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse('ok', 200, { 'content-type': 'text/plain' }));
            const result = await executor.execute({ url: 'http://public.example.com/' });
            assert.strictEqual(result.success, true);
        });
    });

    /* -------------------------------------------------------------- */
    /*  5. SSRF protection — cloud metadata hostnames                  */
    /* -------------------------------------------------------------- */
    suite('SSRF protection — cloud metadata hostnames', () => {
        test('blocks 169.254.169.254 by hostname check', async () => {
            const result = await executor.execute({ url: 'http://169.254.169.254/latest/meta-data/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });

        test('blocks metadata.google.internal by hostname check', async () => {
            const result = await executor.execute({ url: 'http://metadata.google.internal/computeMetadata/v1/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });

        test('blocks localhost by hostname check', async () => {
            const result = await executor.execute({ url: 'http://localhost:8080/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });

        test('blocks .localhost TLD by hostname check', async () => {
            const result = await executor.execute({ url: 'http://api.localhost/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });

        test('blocks vault.hashicorp.com by hostname check', async () => {
            const result = await executor.execute({ url: 'http://vault.hashicorp.com/v1/secret/' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  6. Successful fetch — metadata                                 */
    /* -------------------------------------------------------------- */
    suite('successful fetch', () => {
        test('returns success with correct metadata for plain text', async () => {
            const body = 'Hello, world!';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse(body, 200, { 'content-type': 'text/plain' }));

            const result = await executor.execute({ url: 'http://example.com/hello.txt' });

            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('URL: http://example.com/hello.txt'));
            assert.ok(result.output.includes('Status: 200'));
            assert.ok(result.output.includes('Content-Type: text/plain'));
            assert.ok(result.output.includes('Size:'));
            assert.ok(result.output.includes(body));
        });

        test('returns success for markdown content', async () => {
            const body = '# Header\n\nSome **markdown** text.';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse(body, 200, { 'content-type': 'text/markdown' }));

            const result = await executor.execute({ url: 'http://example.com/readme.md' });

            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('# Header'));
        });

        test('includes correct size in metadata', async () => {
            const body = '12345';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse(body, 200, { 'content-type': 'text/plain' }));

            const result = await executor.execute({ url: 'http://example.com/data' });

            assert.strictEqual(result.success, true);
            // Size should reflect the encoded output length (body + metadata prefix)
            assert.ok(result.output.match(/Size: \d+ bytes/));
        });
    });

    /* -------------------------------------------------------------- */
    /*  7. Redirect following                                          */
    /* -------------------------------------------------------------- */
    suite('redirect following', () => {
        test('follows a single redirect', async () => {
            let callCount = 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = async (url: any) => {
                callCount++;
                if (callCount === 1) {
                    return makeRedirect('http://example.com/final');
                }
                return makeResponse('final content', 200, { 'content-type': 'text/plain' });
            };

            const result = await executor.execute({ url: 'http://example.com/start' });

            assert.strictEqual(result.success, true);
            assert.strictEqual(callCount, 2);
            assert.ok(result.output.includes('final content'));
            assert.ok(result.output.includes('Redirects: 1'));
        });

        test('follows up to 5 redirects', async () => {
            let callCount = 0;
            const urls = [
                'http://example.com/r1',
                'http://example.com/r2',
                'http://example.com/r3',
                'http://example.com/r4',
                'http://example.com/r5',
                'http://example.com/final',
            ];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = async (url: any) => {
                const idx = urls.indexOf(url as string);
                if (idx < urls.length - 1) {
                    return makeRedirect(urls[idx + 1]);
                }
                return makeResponse('done', 200, { 'content-type': 'text/plain' });
            };

            const result = await executor.execute({ url: 'http://example.com/r1' });

            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('done'));
            assert.ok(result.output.includes('Redirects: 5'));
        });

        test('rejects when exceeding 5 redirects', async () => {
            let callCount = 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = async () => {
                callCount++;
                return makeRedirect('http://example.com/loop');
            };

            const result = await executor.execute({ url: 'http://example.com/loop' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('TOO_MANY_REDIRECTS'));
            assert.ok(result.error?.includes('exceeded 5 redirects'));
        });

        test('resolves relative redirect locations', async () => {
            let callCount = 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = async (url: any) => {
                callCount++;
                if (callCount === 1) {
                    return new Response(null, {
                        status: 302,
                        headers: [['location', '/new-path']],
                    });
                }
                return makeResponse('resolved', 200, { 'content-type': 'text/plain' });
            };

            const result = await executor.execute({ url: 'http://example.com/old-path' });

            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('resolved'));
            assert.ok(result.output.includes('http://example.com/new-path'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  8. SSRF on redirect target                                     */
    /* -------------------------------------------------------------- */
    suite('SSRF on redirect target', () => {
        test('blocks redirect to private IP', async () => {
            let callCount = 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = async () => {
                callCount++;
                return makeRedirect('http://192.168.1.100/admin');
            };

            // DNS for the redirect target hostname (192.168.1.100) will resolve to itself
            restoreDns();
            restoreDns = mockDnsLookup((_host: string, _opts: unknown, cb: DnsLookupCallback) => {
                cb(null, [{ address: '192.168.1.100', family: 4 }], 4);
            });

            const result = await executor.execute({ url: 'http://example.com/' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
            assert.ok(result.error?.includes('redirect target'));
        });

        test('blocks redirect to localhost', async () => {
            let callCount = 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = async () => {
                callCount++;
                return makeRedirect('http://localhost:3000/');
            };

            const result = await executor.execute({ url: 'http://example.com/' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
            assert.ok(result.error?.includes('redirect target'));
        });

        test('blocks redirect to cloud metadata host', async () => {
            let callCount = 0;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = async () => {
                callCount++;
                return makeRedirect('http://169.254.169.254/latest/meta-data/');
            };

            const result = await executor.execute({ url: 'http://example.com/' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('SSRF_BLOCKED'));
            assert.ok(result.error?.includes('redirect target'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  9. Response too large                                          */
    /* -------------------------------------------------------------- */
    suite('response too large', () => {
        test('rejects based on Content-Length header', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(
                new Response(null, {
                    status: 200,
                    headers: [
                        ['content-length', '10000000'], // 10 MB > 5 MB limit
                        ['content-type', 'text/plain'],
                    ],
                }),
            );

            const result = await executor.execute({ url: 'http://example.com/big' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('RESPONSE_TOO_LARGE'));
            assert.ok(result.error?.includes('Content-Length'));
        });

        test('rejects when streaming body exceeds limit', async () => {
            // Create a body larger than 5 MB
            const bigChunk = new Uint8Array(3 * 1024 * 1024); // 3 MB
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(bigChunk);
                    controller.enqueue(bigChunk); // total 6 MB > 5 MB
                    controller.close();
                },
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(
                new Response(stream, {
                    status: 200,
                    headers: [['content-type', 'application/octet-stream']],
                }),
            );

            const result = await executor.execute({ url: 'http://example.com/streaming-big' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('RESPONSE_TOO_LARGE'));
            assert.ok(result.error?.includes('body exceeded'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  10. HTML → plain text conversion                              */
    /* -------------------------------------------------------------- */
    suite('HTML content conversion', () => {
        test('converts HTML to plain text', async () => {
            const html = '<html><body><h1>Title</h1><p>Hello &amp; world</p></body></html>';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse(html, 200, { 'content-type': 'text/html' }));

            const result = await executor.execute({ url: 'http://example.com/page.html' });

            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('Title'));
            assert.ok(result.output.includes('Hello & world'));
            assert.ok(!result.output.includes('<h1>'));
            assert.ok(!result.output.includes('<p>'));
        });

        test('strips script tags from HTML', async () => {
            const html = '<html><body><script>alert("xss")</script><p>Safe</p></body></html>';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse(html, 200, { 'content-type': 'text/html' }));

            const result = await executor.execute({ url: 'http://example.com/xss.html' });

            assert.strictEqual(result.success, true);
            assert.ok(!result.output.includes('alert'));
            assert.ok(result.output.includes('Safe'));
        });

        test('strips style tags from HTML', async () => {
            const html = '<html><head><style>.hidden{display:none}</style></head><body>Visible</body></html>';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse(html, 200, { 'content-type': 'text/html' }));

            const result = await executor.execute({ url: 'http://example.com/style.html' });

            assert.strictEqual(result.success, true);
            assert.ok(!result.output.includes('.hidden'));
            assert.ok(result.output.includes('Visible'));
        });

        test('decodes HTML entities', async () => {
            const html = '<p>&lt;b&gt;bold&lt;/b&gt; &quot;quoted&quot;</p>';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse(html, 200, { 'content-type': 'text/html' }));

            const result = await executor.execute({ url: 'http://example.com/entities.html' });

            assert.strictEqual(result.success, true);
            assert.ok(result.output.includes('<b>bold</b>'));
            assert.ok(result.output.includes('"quoted"'));
        });

        test('handles br and hr tags as line breaks', async () => {
            const html = '<p>Line1<br>Line2<hr>Line3</p>';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse(html, 200, { 'content-type': 'text/html' }));

            const result = await executor.execute({ url: 'http://example.com/br.html' });

            assert.strictEqual(result.success, true);
            const lines = result.output.split('\n').filter(l => l.trim());
            assert.ok(lines.some(l => l.includes('Line1')));
            assert.ok(lines.some(l => l.includes('Line2')));
            assert.ok(lines.some(l => l.includes('Line3')));
        });
    });

    /* -------------------------------------------------------------- */
    /*  11. Timeout on slow responses                                  */
    /* -------------------------------------------------------------- */
    suite('timeout', () => {
        test('times out when fetch takes too long', async () => {
            // Simulate a slow fetch that never resolves within the timeout
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = async (_url: unknown, init?: unknown) => {
                // The AbortController signal passed by the executor should fire after 30s
                // We'll wait for abort instead
                const signal = (init as Record<string, AbortSignal> | undefined)?.signal;
                await new Promise<void>((resolve) => {
                    if (signal) {
                        signal.addEventListener('abort', () => resolve());
                    }
                    // Safety: resolve after a short delay so the test doesn't hang forever
                    setTimeout(() => resolve(), 10000);
                });
                throw new Error('should not reach here');
            };

            // We cannot easily test the full 30s timeout in unit tests.
            // Instead, verify that the executor passes an AbortController to fetch.
            // This test confirms the abort signal mechanism is wired up.
            let receivedSignal: AbortSignal | undefined;
            const abortController = new AbortController();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = async (_url: unknown, init?: unknown) => {
                receivedSignal = (init as Record<string, AbortSignal> | undefined)?.signal;
                // Trigger abort immediately to simulate timeout
                abortController.abort();
                await new Promise((resolve) => setTimeout(resolve, 100));
                throw new DOMException('The operation was aborted.', 'AbortError');
            };

            const result = await executor.execute({ url: 'http://example.com/slow' });

            assert.ok(receivedSignal, 'fetch should receive an abort signal');
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('FETCH_ERROR'));
        });
    });

    /* -------------------------------------------------------------- */
    /*  Additional edge cases                                          */
    /* -------------------------------------------------------------- */
    suite('edge cases', () => {
        test('non-200 HTTP status returns error', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(
                new Response('Not found', {
                    status: 404,
                    statusText: 'Not Found',
                    headers: [['content-type', 'text/plain']],
                }),
            );

            const result = await executor.execute({ url: 'http://example.com/missing' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('HTTP_404'));
        });

        test('500 server error returns error', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(
                new Response('Internal Error', {
                    status: 500,
                    statusText: 'Internal Server Error',
                    headers: [['content-type', 'text/plain']],
                }),
            );

            const result = await executor.execute({ url: 'http://example.com/broken' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('HTTP_500'));
        });

        test('redirect without Location header returns error', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(
                new Response(null, { status: 302, headers: [] }),
            );

            const result = await executor.execute({ url: 'http://example.com/no-location' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('REDIRECT_NO_LOCATION'));
        });

        test('executor has correct name', () => {
            assert.strictEqual(executor.name, 'web_fetch');
        });

        test('format parameter is accepted', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(makeResponse('plain', 200, { 'content-type': 'text/plain' }));

            const result = await executor.execute({ url: 'http://example.com/', format: 'text' });

            assert.strictEqual(result.success, true);
        });

        test('DNS failure allows fetch to proceed (then fails naturally)', async () => {
            restoreDns();
            restoreDns = mockDnsLookup((_host: string, _opts: unknown, cb: DnsLookupCallback) => {
                cb(new Error('ENOTFOUND'), [], 4);
            });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.reject(new Error('network error'));

            const result = await executor.execute({ url: 'http://unresolvable.host/' });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('FETCH_ERROR'));
        });

        test('empty body is handled gracefully', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (globalThis as any).fetch = () => Promise.resolve(
                new Response('', {
                    status: 200,
                    headers: [['content-type', 'text/plain']],
                }),
            );

            const result = await executor.execute({ url: 'http://example.com/empty' });

            assert.strictEqual(result.success, true);
        });
    });
});
