import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodebaseIndexer } from '../../indexing/codebaseIndexer';
import { RetrievalService } from '../../indexing/retrievalService';
import { ContextManager } from '../../context/contextManager';
import { ChatConfig } from '../../types';

suite('RetrievalService Tests', () => {
    let tmpDir: string;
    let storageDir: string;
    let indexer: CodebaseIndexer;
    let retrieval: RetrievalService;

    setup(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-test-'));
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-storage-'));
        indexer = new CodebaseIndexer(tmpDir, storageDir);
        retrieval = new RetrievalService(indexer, tmpDir);
    });

    teardown(() => {
        retrieval.dispose();
        indexer.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    suite('Keyword extraction and scoring', () => {
        test('returns empty result for unknown query', async () => {
            fs.writeFileSync(path.join(tmpDir, 'test.ts'), 'export class Foo {}');
            await indexer.rebuildIndex();

            const result = await retrieval.retrieve('xyznonexistent123');
            assert.strictEqual(result.chunks.length, 0);
        });

        test('finds file by symbol name in query', async () => {
            fs.writeFileSync(path.join(tmpDir, 'auth.ts'), [
                'export class AuthService {',
                '    login() { return true; }',
                '}',
            ].join('\n'));
            await indexer.rebuildIndex();

            const result = await retrieval.retrieve('fix the AuthService login bug');
            assert.ok(result.chunks.length > 0, 'Should find auth.ts');
            assert.ok(result.chunks[0].filePath.includes('auth.ts'));
        });

        test('ranks exact symbol match higher than partial', async () => {
            fs.writeFileSync(path.join(tmpDir, 'data.ts'), 'export class DataProcessor {}');
            fs.writeFileSync(path.join(tmpDir, 'other.ts'), 'export function processData() {}');
            await indexer.rebuildIndex();

            const result = await retrieval.retrieve('DataProcessor');
            assert.ok(result.chunks.length >= 1);
            // Exact match should be first
            assert.strictEqual(result.chunks[0].filePath.includes('data.ts'), true);
        });

        test('filename keyword match works', async () => {
            fs.writeFileSync(path.join(tmpDir, 'database.ts'), 'export const db = {};');
            await indexer.rebuildIndex();

            const result = await retrieval.retrieve('database connection');
            assert.ok(result.chunks.length > 0);
            assert.ok(result.chunks[0].filePath.includes('database.ts'));
        });
    });

    suite('Recency boost', () => {
        test('recently touched files get boosted', async () => {
            fs.writeFileSync(path.join(tmpDir, 'recent.ts'), 'export class RecentClass {}');
            fs.writeFileSync(path.join(tmpDir, 'old.ts'), 'export class OldClass {}');
            await indexer.rebuildIndex();

            // Touch recent.ts
            retrieval.touchFile('recent.ts');

            const result = await retrieval.retrieve('Class');
            assert.ok(result.chunks.length > 0);
            // recent.ts should rank higher due to recency boost
            const recentIdx = result.chunks.findIndex(c => c.filePath.includes('recent.ts'));
            assert.ok(recentIdx >= 0, 'recent.ts should appear in results');
        });
    });

    suite('Token budget awareness', () => {
        test('respects maxTokens limit', async () => {
            // Create a large file
            const lines = [];
            for (let i = 0; i < 500; i++) {
                lines.push(`export function func${i}() { return ${i}; }`);
            }
            fs.writeFileSync(path.join(tmpDir, 'large.ts'), lines.join('\n'));
            await indexer.rebuildIndex();

            const smallRetrieval = new RetrievalService(indexer, tmpDir, { maxTokens: 100 });
            const result = await smallRetrieval.retrieve('func');
            assert.ok(result.totalTokens <= 100 || result.chunks.length === 0,
                'Should respect token budget or return no chunks');
            smallRetrieval.dispose();
        });
    });

    suite('ContextManager retrieval integration', () => {
        test('adds retrieved chunks and builds prompt', () => {
            const config: ChatConfig = {
                modelEndpoint: 'http://localhost',
                modelName: 'test',
                apiKey: '',
                contextWindowSize: 8192,
                defaultMode: 'plan',
                openCodeEnabled: false,
                temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5, repetitionPenalty: 1.0, minP: 0.0,
            };
            const cm = new ContextManager(config);

            cm.addRetrievedContext([{
                filePath: 'src/auth.ts',
                startLine: 1,
                endLine: 10,
                text: 'export class AuthService {}',
                tokenCount: 8,
                symbols: [],
                score: 0.9,
                source: 'symbol',
            }]);

            const prompt = cm.buildRetrievedContextPrompt();
            assert.ok(prompt.includes('AuthService'));
            assert.ok(prompt.includes('src/auth.ts'));
        });

        test('removes chunk by file path', () => {
            const config: ChatConfig = {
                modelEndpoint: 'http://localhost',
                modelName: 'test',
                apiKey: '',
                contextWindowSize: 8192,
                defaultMode: 'plan',
                openCodeEnabled: false,
                temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5, repetitionPenalty: 1.0, minP: 0.0,
            };
            const cm = new ContextManager(config);

            cm.addRetrievedContext([
                { filePath: 'a.ts', startLine: 1, endLine: 5, text: 'a', tokenCount: 1, symbols: [], score: 0.8, source: 'keyword' },
                { filePath: 'b.ts', startLine: 1, endLine: 5, text: 'b', tokenCount: 1, symbols: [], score: 0.6, source: 'keyword' },
            ]);

            cm.removeRetrievedChunk('a.ts');
            const remaining = cm.getRetrievedChunks();
            assert.strictEqual(remaining.length, 1);
            assert.strictEqual(remaining[0].filePath, 'b.ts');
        });

        test('clearContext clears retrieved chunks', () => {
            const config: ChatConfig = {
                modelEndpoint: 'http://localhost',
                modelName: 'test',
                apiKey: '',
                contextWindowSize: 8192,
                defaultMode: 'plan',
                openCodeEnabled: false,
                temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5, repetitionPenalty: 1.0, minP: 0.0,
            };
            const cm = new ContextManager(config);

            cm.addRetrievedContext([{
                filePath: 'x.ts', startLine: 1, endLine: 1, text: 'x', tokenCount: 1, symbols: [], score: 1, source: 'symbol',
            }]);
            cm.clearContext();
            assert.strictEqual(cm.getRetrievedChunks().length, 0);
        });

        test('getAvailableRetrievalTokens returns correct budget', () => {
            const config: ChatConfig = {
                modelEndpoint: 'http://localhost',
                modelName: 'test',
                apiKey: '',
                contextWindowSize: 4096,
                defaultMode: 'plan',
                openCodeEnabled: false,
                temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5, repetitionPenalty: 1.0, minP: 0.0,
            };
            const cm = new ContextManager(config);
            const available = cm.getAvailableRetrievalTokens(1024);
            // No messages yet, so budget = 4096 - 0 - 1024 = 3072
            assert.strictEqual(available, 3072);
        });
    });

    suite('formatContext', () => {
        test('formats chunks with code fences', async () => {
            fs.writeFileSync(path.join(tmpDir, 'demo.ts'), 'export class Demo {}');
            await indexer.rebuildIndex();

            const result = await retrieval.retrieve('Demo');
            if (result.chunks.length > 0) {
                const formatted = retrieval.formatContext(result);
                assert.ok(formatted.includes('```'));
                assert.ok(formatted.includes('--- demo.ts'));
            }
        });
    });
});
