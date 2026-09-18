import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ObservabilityService, RequestLog, SessionStats } from '../../observability/observability';

suite('ObservabilityService', () => {
    let tmpDir: string;
    let obs: ObservabilityService;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
    });

    teardown(() => {
        obs?.dispose();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    function createObs(): ObservabilityService {
        obs = new ObservabilityService(tmpDir);
        return obs;
    }

    // --- Stats computation ---

    test('getStats returns zeros when no logs recorded', () => {
        const s = createObs();
        const stats = s.getStats();
        assert.strictEqual(stats.requestCount, 0);
        assert.strictEqual(stats.totalInputTokens, 0);
        assert.strictEqual(stats.totalOutputTokens, 0);
        assert.strictEqual(stats.avgLatencyMs, 0);
        assert.strictEqual(stats.avgTtftMs, 0);
        assert.strictEqual(stats.errorCount, 0);
        assert.strictEqual(stats.errorRate, 0);
    });

    test('getStats aggregates single success request', () => {
        const s = createObs();
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 1200,
            ttftMs: 300,
            inputTokens: 500,
            outputTokens: 200,
            toolCallCount: 2,
            httpStatus: 200,
            error: null,
        });

        const stats = s.getStats();
        assert.strictEqual(stats.requestCount, 1);
        assert.strictEqual(stats.totalInputTokens, 500);
        assert.strictEqual(stats.totalOutputTokens, 200);
        assert.strictEqual(stats.avgLatencyMs, 1200);
        assert.strictEqual(stats.avgTtftMs, 300);
        assert.strictEqual(stats.errorCount, 0);
        assert.strictEqual(stats.errorRate, 0);
    });

    test('getStats averages across multiple requests', () => {
        const s = createObs();
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 1000,
            ttftMs: 200,
            inputTokens: 400,
            outputTokens: 100,
            toolCallCount: 0,
            httpStatus: 200,
            error: null,
        });
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 2000,
            ttftMs: 600,
            inputTokens: 600,
            outputTokens: 300,
            toolCallCount: 1,
            httpStatus: 200,
            error: null,
        });

        const stats = s.getStats();
        assert.strictEqual(stats.requestCount, 2);
        assert.strictEqual(stats.totalInputTokens, 1000);
        assert.strictEqual(stats.totalOutputTokens, 400);
        assert.strictEqual(stats.avgLatencyMs, 1500);
        assert.strictEqual(stats.avgTtftMs, 400);
        assert.strictEqual(stats.errorCount, 0);
    });

    test('getStats tracks errors correctly', () => {
        const s = createObs();
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 500,
            ttftMs: 0,
            inputTokens: 100,
            outputTokens: 0,
            toolCallCount: 0,
            httpStatus: 500,
            error: 'Internal Server Error',
        });
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 800,
            ttftMs: 100,
            inputTokens: 200,
            outputTokens: 50,
            toolCallCount: 0,
            httpStatus: 200,
            error: null,
        });

        const stats = s.getStats();
        assert.strictEqual(stats.requestCount, 2);
        assert.strictEqual(stats.errorCount, 1);
        assert.strictEqual(stats.errorRate, 0.5);
    });

    test('getStats excludes zero TTFT from average', () => {
        const s = createObs();
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 1000,
            ttftMs: 0, // non-streaming
            inputTokens: 100,
            outputTokens: 50,
            toolCallCount: 0,
            httpStatus: 200,
            error: null,
        });
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 2000,
            ttftMs: 400,
            inputTokens: 200,
            outputTokens: 100,
            toolCallCount: 0,
            httpStatus: 200,
            error: null,
        });

        const stats = s.getStats();
        // Only second request has TTFT > 0
        assert.strictEqual(stats.avgTtftMs, 400);
    });

    // --- Log persistence ---

    test('recordRequest writes JSONL file', () => {
        const s = createObs();
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 500,
            ttftMs: 100,
            inputTokens: 100,
            outputTokens: 50,
            toolCallCount: 0,
            httpStatus: 200,
            error: null,
        });

        const logPath = s.getLogFilePath();
        assert.ok(fs.existsSync(logPath), 'JSONL file should exist');

        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
        assert.strictEqual(lines.length, 1);

        const entry = JSON.parse(lines[0]) as RequestLog;
        assert.strictEqual(entry.model, 'gpt-4');
        assert.strictEqual(entry.latencyMs, 500);
        assert.strictEqual(entry.timestamp !== undefined, true);
    });

    test('multiple requests append to JSONL file', () => {
        const s = createObs();
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 100,
            ttftMs: 50,
            inputTokens: 50,
            outputTokens: 25,
            toolCallCount: 0,
            httpStatus: 200,
            error: null,
        });
        s.recordRequest({
            model: 'claude-3',
            latencyMs: 200,
            ttftMs: 80,
            inputTokens: 100,
            outputTokens: 50,
            toolCallCount: 1,
            httpStatus: 200,
            error: null,
        });

        const logPath = s.getLogFilePath();
        const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
        assert.strictEqual(lines.length, 2);

        const first = JSON.parse(lines[0]) as RequestLog;
        const second = JSON.parse(lines[1]) as RequestLog;
        assert.strictEqual(first.model, 'gpt-4');
        assert.strictEqual(second.model, 'claude-3');
    });

    // --- getLogs ---

    test('getLogs returns copy of recorded entries', () => {
        const s = createObs();
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 300,
            ttftMs: 100,
            inputTokens: 80,
            outputTokens: 40,
            toolCallCount: 0,
            httpStatus: 200,
            error: null,
        });

        const logs = s.getLogs();
        assert.strictEqual(logs.length, 1);
        assert.strictEqual(logs[0].model, 'gpt-4');

        // Mutating returned array doesn't affect internal state
        logs.push({ timestamp: '', model: 'fake', latencyMs: 0, ttftMs: 0, inputTokens: 0, outputTokens: 0, toolCallCount: 0, httpStatus: 0, error: null });
        assert.strictEqual(s.getLogs().length, 1);
    });

    // --- reset ---

    test('reset clears tracked state', () => {
        const s = createObs();
        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 100,
            ttftMs: 50,
            inputTokens: 50,
            outputTokens: 25,
            toolCallCount: 0,
            httpStatus: 200,
            error: null,
        });

        s.reset();

        const stats = s.getStats();
        assert.strictEqual(stats.requestCount, 0);
        assert.strictEqual(s.getLogs().length, 0);
    });

    // --- onStatsUpdate callback ---

    test('onStatsUpdate fires after recordRequest', () => {
        const s = createObs();
        let statsReceived = false;
        let capturedStats: SessionStats = {
            requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0,
            avgLatencyMs: 0, avgTtftMs: 0, errorCount: 0, errorRate: 0,
        };
        s.onStatsUpdate(stats => {
            statsReceived = true;
            capturedStats = stats;
        });

        s.recordRequest({
            model: 'gpt-4',
            latencyMs: 500,
            ttftMs: 100,
            inputTokens: 100,
            outputTokens: 50,
            toolCallCount: 0,
            httpStatus: 200,
            error: null,
        });

        assert.ok(statsReceived, 'callback should have been called');
        assert.strictEqual(capturedStats.requestCount, 1);
        assert.strictEqual(capturedStats.totalInputTokens, 100);
    });

    // --- OutputChannel ---

    test('getOutputChannel returns a channel', () => {
        const s = createObs();
        const ch = s.getOutputChannel();
        assert.ok(ch !== undefined, 'output channel should exist');
    });
});
