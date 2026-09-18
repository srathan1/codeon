import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** A single structured log entry for one API request. */
export interface RequestLog {
    /** ISO-8601 timestamp. */
    timestamp: string;
    /** Model name used for the request. */
    model: string;
    /** Total wall-clock latency in ms. */
    latencyMs: number;
    /** Time to first token in ms (0 if non-streaming). */
    ttftMs: number;
    /** Input token count. */
    inputTokens: number;
    /** Output token count. */
    outputTokens: number;
    /** Number of tool calls emitted by the model. */
    toolCallCount: number;
    /** HTTP status code (0 if no response / exception). */
    httpStatus: number;
    /** Error message, or null on success. */
    error: string | null;
}

/** Aggregated session stats. */
export interface SessionStats {
    /** Total requests in the current session. */
    requestCount: number;
    /** Total input tokens consumed. */
    totalInputTokens: number;
    /** Total output tokens generated. */
    totalOutputTokens: number;
    /** Average latency across all completed requests (ms). */
    avgLatencyMs: number;
    /** Average time-to-first-token (ms, streaming only). */
    avgTtftMs: number;
    /** Number of failed requests. */
    errorCount: number;
    /** Error rate as a fraction 0–1. */
    errorRate: number;
}

/** Callback fired after each completed request with the updated stats. */
export type StatsUpdateCallback = (stats: SessionStats) => void;

export class ObservabilityService {
    private _logs: RequestLog[] = [];
    private _outputChannel: vscode.OutputChannel;
    private _logFilePath: string;
    private _onStatsUpdate: StatsUpdateCallback | undefined;

    constructor(globalStorageUri: string) {
        this._outputChannel = vscode.window.createOutputChannel('CodeOn');
        this._logFilePath = path.join(globalStorageUri, 'request-log.jsonl');
    }

    /** Register a callback that fires after every request with fresh stats. */
    public onStatsUpdate(callback: StatsUpdateCallback): void {
        this._onStatsUpdate = callback;
    }

    /** Get the OutputChannel for external consumers. */
    public getOutputChannel(): vscode.OutputChannel {
        return this._outputChannel;
    }

    /**
     * Record a completed API request.
     * Appends to in-memory list, writes JSONL line, logs to output channel, and fires stats callback.
     */
    public recordRequest(entry: Omit<RequestLog, 'timestamp'>): void {
        const log: RequestLog = {
            ...entry,
            timestamp: new Date().toISOString(),
        };

        this._logs.push(log);

        // Write JSONL line to disk
        try {
            fs.appendFileSync(this._logFilePath, JSON.stringify(log) + '\n');
        } catch (err) {
            console.warn('Failed to write log line:', err);
        }

        // Log to VS Code output channel
        const statusIcon = log.error ? '✗' : '✓';
        const tokenInfo = log.inputTokens + log.outputTokens > 0
            ? `tokens=${log.inputTokens}in+${log.outputTokens}out`
            : '';
        const toolInfo = log.toolCallCount > 0 ? `tools=${log.toolCallCount}` : '';
        const detail = [statusIcon, log.model, `${log.latencyMs}ms`, tokenInfo, toolInfo].filter(Boolean).join(' ');
        if (log.error) {
            this._outputChannel.appendLine(`[${log.timestamp}] ERROR ${detail} — ${log.error}`);
        } else {
            this._outputChannel.appendLine(`[${log.timestamp}] ${detail}`);
        }

        // Fire stats update
        this._onStatsUpdate?.(this.getStats());
    }

    /** Compute aggregated stats from recorded logs. */
    public getStats(): SessionStats {
        const count = this._logs.length;
        if (count === 0) {
            return {
                requestCount: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                avgLatencyMs: 0,
                avgTtftMs: 0,
                errorCount: 0,
                errorRate: 0,
            };
        }

        let totalInput = 0;
        let totalOutput = 0;
        let totalLatency = 0;
        let totalTtft = 0;
        let ttftCount = 0;
        let errors = 0;

        for (const l of this._logs) {
            totalInput += l.inputTokens;
            totalOutput += l.outputTokens;
            totalLatency += l.latencyMs;
            if (l.ttftMs > 0) {
                totalTtft += l.ttftMs;
                ttftCount++;
            }
            if (l.error) errors++;
        }

        return {
            requestCount: count,
            totalInputTokens: totalInput,
            totalOutputTokens: totalOutput,
            avgLatencyMs: Math.round(totalLatency / count),
            avgTtftMs: ttftCount > 0 ? Math.round(totalTtft / ttftCount) : 0,
            errorCount: errors,
            errorRate: errors / count,
        };
    }

    /** Get raw log entries (for export/debugging). */
    public getLogs(): RequestLog[] {
        return [...this._logs];
    }

    /** Get the path to the JSONL log file. */
    public getLogFilePath(): string {
        return this._logFilePath;
    }

    /** Reset all tracked state (new session). */
    public reset(): void {
        this._logs = [];
    }

    /** Dispose output channel. */
    public dispose(): void {
        this._outputChannel.dispose();
    }
}
