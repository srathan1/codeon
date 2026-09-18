import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RiskClass } from './riskModel';

/** Batch write interval for async audit log flushing (ms). */
const FLUSH_INTERVAL_MS = 2000;
/** Maximum lines to buffer before forcing a flush. */
const MAX_BUFFER_SIZE = 50;
/** Rotate the audit log once it grows past this size (P5-T16). */
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB
/** How many rotated audit logs to keep before deleting the oldest. */
const MAX_ROTATED_LOGS = 5;

/**
 * Audit logging for tool invocations (PRD §9.8).
 * Records all tool executions to a local JSONL file with sanitized inputs.
 */

export interface AuditEvent {
    /** ISO-8601 timestamp. */
    timestamp: string;
    /** Unique event ID. */
    eventId: string;
    /** Session identifier. */
    sessionId: string;
    /** Agent identifier (if applicable). */
    agentId?: string;
    /** Task identifier (if applicable). */
    taskId?: string;
    /** Tool name. */
    toolName: string;
    /** Risk classification of this invocation. */
    riskClass: RiskClass;
    /** Sanitized input arguments (secrets redacted). */
    sanitizedInputs: Record<string, unknown>;
    /** Approval decision and approver. */
    approvalDecision?: 'auto_allowed' | 'user_approved' | 'user_denied' | 'timeout_denied';
    /** Workspace path scope. */
    workspacePath?: string;
    /** Before-and-after hashes for mutations. */
    beforeHash?: string;
    afterHash?: string;
    /** Exit code or outcome summary. */
    outcome: 'success' | 'error' | 'cancelled' | 'denied';
    /** Error category (if failed). */
    errorCategory?: string;
    /** Duration in milliseconds. */
    durationMs: number;
    /** Policy version. */
    policyVersion: string;
}

/**
 * Audit logger that writes events to a JSONL file and VS Code OutputChannel.
 */
export class AuditLogger {
    private outputChannel: vscode.OutputChannel;
    private logFilePath: string | null = null;
    private policyVersion: string = '1.0.0';
    private _buffer: string[] = [];
    private _flushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(policyVersion?: string) {
        this.outputChannel = vscode.window.createOutputChannel('Tool Audit Log');
        this.policyVersion = policyVersion ?? '1.0.0';
    }

    /**
     * Get or create the audit log file path, outside the workspace (S-2).
     *
     * Previously this lived under `<workspace>/.codeon/audit.jsonl` —
     * protected only by riskModel's targetsAuditTrail escalation, which in
     * turn depends on isAuditTrailPath()/commandReferencesAuditTrail()
     * correctly recognizing every path that resolves to that file. Any gap
     * in that path-detection (e.g. the TOCTOU/symlink issues fixed in H-7/L-5)
     * would have let a tool call read, tamper with, or delete its own audit
     * trail. Writing to the extension's global storage dir instead removes
     * that dependency entirely: the log is no longer inside any directory
     * tree a workspace-scoped tool call can reach via path resolution.
     */
    private getLogPath(): string {
        if (this.logFilePath) return this.logFilePath;

        const baseDir = _globalStorageDir ?? vscode.env.appRoot;
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }
        this.logFilePath = path.join(baseDir, 'audit.jsonl');
        return this.logFilePath;
    }

    /**
     * Record an audit event. Buffers the JSON line and flushes asynchronously
     * to avoid blocking the event loop with synchronous disk I/O.
     */
    public record(event: AuditEvent): void {
        const line = JSON.stringify(event, null, 0);

        // Always log to OutputChannel immediately (in-memory only)
        this.outputChannel.appendLine(
            `[${event.timestamp}] ${event.toolName} (${event.riskClass}) → ${event.outcome} ` +
            `(${event.durationMs}ms) [${event.eventId}]`
        );

        // Buffer for async file write
        this._buffer.push(line);

        if (this._buffer.length >= MAX_BUFFER_SIZE) {
            this._flushNow();
        } else if (!this._flushTimer) {
            this._flushTimer = setTimeout(() => this._flushNow(), FLUSH_INTERVAL_MS);
        }
    }

    /** Flush buffered lines to disk asynchronously. */
    private _flushNow(): void {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }

        const lines = this._buffer;
        this._buffer = [];

        if (lines.length === 0) return;

        const content = lines.join('\n') + '\n';

        setImmediate(() => {
            try {
                const logPath = this.getLogPath();
                this._rotateIfNeeded(logPath);
                fs.appendFile(logPath, content, (err) => {
                    if (err) {
                        console.warn('Failed to write audit log:', err.message);
                    }
                });
            } catch (e) {
                // Fail silently — audit should not break tool execution
                console.warn('Failed to write audit log:', (e as Error).message);
            }
        });
    }

    /**
     * Rotate the audit log when it exceeds MAX_LOG_BYTES (P5-T16): rename the
     * current file to `audit.jsonl.<timestamp>` and prune the oldest rotated
     * logs beyond MAX_ROTATED_LOGS. Best-effort — any failure just means we keep
     * appending to the current file, which is preferable to losing the write.
     */
    private _rotateIfNeeded(logPath: string): void {
        try {
            const stat = fs.statSync(logPath);
            if (stat.size < MAX_LOG_BYTES) return;

            const rotated = `${logPath}.${Date.now()}`;
            fs.renameSync(logPath, rotated);

            // Prune oldest rotated logs.
            const dir = path.dirname(logPath);
            const base = path.basename(logPath);
            const rotations = fs.readdirSync(dir)
                .filter(f => f.startsWith(base + '.'))
                .sort(); // timestamp suffix sorts chronologically
            while (rotations.length > MAX_ROTATED_LOGS) {
                const oldest = rotations.shift()!;
                try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* ignore */ }
            }
        } catch {
            // statSync throws if the file doesn't exist yet — nothing to rotate.
        }
    }

    /** Show the audit log channel. */
    public show(): void {
        this.outputChannel.show();
    }

    /** Dispose resources. */
    public dispose(): void {
        this._flushNow();
        this.outputChannel.dispose();
    }
}

/** Global audit logger singleton. */
let _auditLogger: AuditLogger | null = null;

/**
 * S-2: directory (extension global storage) the audit log is written under,
 * outside any workspace. Set once during activation via configureAuditLogger();
 * getLogPath() falls back to vscode.env.appRoot if never configured (e.g. in
 * tests that construct a logger without going through activation).
 */
let _globalStorageDir: string | null = null;

/**
 * Configure the directory audit logs are written to. Call once during
 * extension activation with `context.globalStorageUri.fsPath`, before any
 * tool call could trigger the first getAuditLogger() (and therefore the
 * first getLogPath()) call.
 */
export function configureAuditLogger(globalStorageDir: string): void {
    _globalStorageDir = globalStorageDir;
}

export function getAuditLogger(): AuditLogger {
    if (!_auditLogger) {
        _auditLogger = new AuditLogger();
    }
    return _auditLogger;
}
