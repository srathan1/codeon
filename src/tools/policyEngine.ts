import * as crypto from 'crypto';
import { RiskClass, classifyRisk, RISK_DESCRIPTIONS, requiresApproval as defaultRequiresApproval, isDenied, RiskFactors } from './riskModel';
import { AuditLogger, getAuditLogger, AuditEvent } from './auditLogger';
import { redactSecrets, redactArgs } from './secretRedaction';
import { storeContent, needsHandle, ContentHandle } from './contentHandle';

/**
 * Universal Tool Execution Contract (PRD §8).
 */

/** Tool invocation input. */
export interface ToolInvocation {
    invocationId: string;
    toolName: string;
    input: Record<string, unknown>;
    workspaceId: string;
    agentId?: string;
    taskId?: string;
    sessionId: string;
    requestedAt: string;
    dryRun?: boolean;
}

/** Warning emitted during tool execution. */
export interface ToolWarning {
    code: string;
    message: string;
}

/** Diagnostic for structured error reporting. */
export interface ToolDiagnostic {
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
    path?: string;
    range?: { startLine: number; endLine: number };
}

/** Rich tool result matching PRD §8. */
export interface PolicyToolResult<TData = unknown> {
    invocationId: string;
    status: 'success' | 'error' | 'cancelled' | 'partial' | 'approval_required';
    summary: string;
    data?: TData;
    warnings?: ToolWarning[];
    diagnostics?: ToolDiagnostic[];
    contentHandles?: ContentHandle[];
    auditEventId: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    truncated?: boolean;
    retryable?: boolean;
}

/** Policy decision returned by the policy engine. */
export interface PolicyDecision {
    decision: 'allow' | 'deny' | 'require_approval';
    riskClass: RiskClass;
    reasons: string[];
    approvalScopeOptions?: string[];
}

/**
 * Policy Engine (PRD §16).
 * Evaluates tool invocations against user settings, workspace trust,
 * tool identity, and risk factors to produce a policy decision.
 */
export interface PolicyConfig {
    /** Require workspace trust for mutations. */
    trustedRequiredForExecution: boolean;
    /** Auto-approve targeted edits in trusted workspaces. */
    autoApproveTargetedEdits: boolean;
    /** Auto-approve safe commands matching approved patterns. */
    autoApproveSafeCommands: boolean;
    /** Allowed command patterns (for auto-approval). */
    allowedCommandPatterns: string[];
    /** Blocked command patterns. */
    blockedCommandPatterns: string[];
}

const DEFAULT_POLICY_CONFIG: PolicyConfig = {
    trustedRequiredForExecution: true,
    autoApproveTargetedEdits: false,
    autoApproveSafeCommands: false,
    allowedCommandPatterns: [],
    blockedCommandPatterns: ['rm -rf', ':(){ :|:};', 'mkfs', 'dd if='],
};

/** Escape a literal string for safe embedding in a RegExp. */
function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Cache of compiled blocklist-pattern regexes, keyed by the raw pattern string. */
const _blockedPatternRegexCache = new Map<string, RegExp>();

/**
 * Build (and cache) a regex that matches a blocklist pattern robustly
 * against whitespace variation (C-1). A plain `.includes()` substring check
 * let "rm -rf" survive trivially as "rm  -rf" or other extra-whitespace
 * insertion — this collapses each space in the pattern to `\s+` so any
 * amount of whitespace between its tokens still matches, and requires a
 * word boundary (`\b`) on whichever edge of the pattern is itself a word
 * character, so "mkfs" can't be embedded inside a longer unrelated word
 * like "mkfsomething" or "unmkfs".
 *
 * The boundary is applied conditionally per edge rather than unconditionally
 * wrapping the whole pattern in `\b`, because `\b` only exists at a
 * transition between a word char and a non-word char. An edge that's
 * already a literal non-word/punctuation character (e.g. the trailing "="
 * in "dd if=") needs no boundary of its own — the punctuation already
 * disambiguates it — and *requiring* one there would be wrong: two adjacent
 * non-word characters (e.g. "=" followed by "/" in "dd if=/dev/zero") never
 * form a `\b`, so an unconditional trailing `\b` would make this pattern
 * fail to match the exact real-world command it exists to block. Native
 * `\b` on a word-character edge, on the other hand, correctly matches
 * "mkfs.ext4" (boundary between "s" and ".") while still rejecting
 * "mkfsomething" (no boundary between two word chars) — simpler and more
 * correct than manually enumerating boundary characters.
 *
 * This is NOT a complete fix for command-injection-style obfuscation (e.g.
 * `rm${IFS}-rf` defeats this the same way it defeats the regexes in
 * riskModel.ts — `${IFS}` is literal, non-whitespace text until a real
 * shell expands it, so no static pattern match over the raw string can
 * catch it). That class of bypass can only be closed by not shell-executing
 * untrusted strings at all (allowlisting / non-shell argv exec), not by a
 * better blocklist — see NEW_FINDINGS_PRD.md C-1/S-1.
 */
function buildBlockedPatternRegex(pattern: string): RegExp {
    let re = _blockedPatternRegexCache.get(pattern);
    if (!re) {
        const trimmed = pattern.trim();
        const escaped = trimmed.split(/\s+/).map(escapeRegExp).join('\\s+');
        const leadBoundary = /^\w/.test(trimmed) ? '\\b' : '';
        const trailBoundary = /\w$/.test(trimmed) ? '\\b' : '';
        re = new RegExp(leadBoundary + escaped + trailBoundary, 'i');
        _blockedPatternRegexCache.set(pattern, re);
    }
    return re;
}

/**
 * Policy engine instance.
 */
export class PolicyEngine {
    private config: PolicyConfig;
    private auditLogger: AuditLogger;

    constructor(config?: Partial<PolicyConfig>) {
        this.config = { ...DEFAULT_POLICY_CONFIG, ...config };
        this.auditLogger = getAuditLogger();
    }

    /** Update policy configuration. */
    public updateConfig(patch: Partial<PolicyConfig>): void {
        this.config = { ...this.config, ...patch };
    }

    /**
     * Evaluate a tool invocation and return a policy decision.
     */
    public evaluate(invocation: ToolInvocation, riskFactors: RiskFactors): PolicyDecision {
        const riskClass = classifyRisk(riskFactors);
        const reasons: string[] = [];

        // Check if denied by default
        if (isDenied(riskClass)) {
            return {
                decision: 'deny',
                riskClass,
                reasons: [`Tool is ${riskClass} (${RISK_DESCRIPTIONS[riskClass]}), denied by default policy`],
            };
        }

        // Command-specific checks
        if (invocation.toolName === 'execute_command' && invocation.input.command) {
            const cmd = String(invocation.input.command);
            const blocked = this.config.blockedCommandPatterns.find(p =>
                buildBlockedPatternRegex(p).test(cmd)
            );
            if (blocked) {
                return {
                    decision: 'deny',
                    riskClass,
                    reasons: [`Command matches blocklist pattern: '${blocked}'`],
                };
            }
        }

        // Determine approval requirement
        let decision: 'allow' | 'deny' | 'require_approval';

        if (defaultRequiresApproval(riskClass)) {
            // Check auto-approval conditions
            if (riskClass === 'R1' && this.config.autoApproveTargetedEdits) {
                decision = 'allow';
                reasons.push('Auto-approved: targeted edit in trusted workspace');
            } else if (riskClass === 'R2' && this.config.autoApproveSafeCommands) {
                decision = 'allow';
                reasons.push('Auto-approved: safe command pattern');
            } else {
                decision = 'require_approval';
                reasons.push(`Requires approval: ${riskClass} (${RISK_DESCRIPTIONS[riskClass]})`);
            }
        } else {
            decision = 'allow';
            reasons.push(`Allowed: ${riskClass} (${RISK_DESCRIPTIONS[riskClass]})`);
        }

        return {
            decision,
            riskClass,
            reasons,
            approvalScopeOptions: decision === 'require_approval' ? [
                'allow_once',
                'allow_for_session',
                'always_allow_in_workspace',
                'deny',
            ] : undefined,
        };
    }
}

/** Global policy engine singleton. */
let _policyEngine: PolicyEngine | null = null;

export function getPolicyEngine(): PolicyEngine {
    if (!_policyEngine) {
        _policyEngine = new PolicyEngine();
    }
    return _policyEngine;
}

export function setPolicyEngine(engine: PolicyEngine): void {
    _policyEngine = engine;
}

/**
 * Generate a unique invocation ID.
 */
export function generateInvocationId(): string {
    return 'inv_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Generate a unique audit event ID.
 */
export function generateAuditEventId(): string {
    return 'audit_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Execute a tool with the full universal envelope:
 * 1. Generate invocation ID
 * 2. Redact secrets from inputs
 * 3. Evaluate policy
 * 4. Execute (or request approval)
 * 5. Store large output behind content handles
 * 6. Record audit event
 * 7. Return structured result
 */
export async function executeWithEnvelope<TData = unknown>(
    invocation: ToolInvocation,
    riskFactors: RiskFactors,
    approvalCallback?: () => Promise<boolean>,
    executor?: (input: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string; data?: TData }>,
    alreadyApproved = false,
): Promise<PolicyToolResult<TData>> {
    const policyEngine = getPolicyEngine();
    const auditLogger = getAuditLogger();

    const startedAt = invocation.requestedAt ?? new Date().toISOString();
    const startTime = Date.now();

    // Step 1: Redact secrets from inputs
    const { args: sanitizedInputs, redactionCount } = redactArgs(invocation.input);
    const warnings: ToolWarning[] = [];
    if (redactionCount > 0) {
        warnings.push({ code: 'SECRET_REDACTED', message: `${redactionCount} suspected secret(s) redacted from input` });
    }

    // Step 2: Evaluate policy
    const decision = policyEngine.evaluate(invocation, riskFactors);

    // Step 3: Check approval (skip if already approved at the tool handler level)
    if (decision.decision === 'require_approval' && !alreadyApproved) {
        if (!approvalCallback) {
            return finishResult(invocation, startedAt, startTime, {
                status: 'approval_required',
                summary: `Approval required: ${decision.reasons.join('; ')}`,
                warnings,
            });
        }
        const approved = await approvalCallback();
        if (!approved) {
            return finishResult(invocation, startedAt, startTime, {
                status: 'error',
                summary: 'Tool invocation denied by user',
                outcome: 'denied',
                approvalDecision: 'user_denied',
                warnings,
                sanitizedInputs,
                riskClass: decision.riskClass,
            });
        }
    }

    if (decision.decision === 'deny') {
        return finishResult(invocation, startedAt, startTime, {
            status: 'error',
            summary: `Tool denied by policy: ${decision.reasons.join('; ')}`,
            outcome: 'error',
            errorCategory: 'PERMISSION_DENIED',
            warnings,
            sanitizedInputs,
            riskClass: decision.riskClass,
        });
    }

    // Step 4: Execute
    try {
        if (!executor) {
            return finishResult(invocation, startedAt, startTime, {
                status: 'error',
                summary: 'No executor provided',
                outcome: 'error',
                errorCategory: 'TOOL_NOT_AVAILABLE',
                warnings,
                sanitizedInputs,
                riskClass: decision.riskClass,
            });
        }
        // H-6/S-3: the executor receives the RAW (unredacted) input, not
        // sanitizedInputs, intentionally — executors like write_file/
        // execute_command must act on the actual bytes the user/model
        // provided (a redacted content string would silently corrupt a real
        // file write or execute a broken command whenever legitimate content
        // happens to match a secret-shaped pattern, e.g. a .env.example
        // template or test fixture). No executor currently logs its raw
        // input (verified), so the actual leak vector is an executor's own
        // *error message* surfacing raw input back through this envelope —
        // that path is redacted below, which closes the real risk without
        // breaking functional executors that need exact input fidelity.
        const execResult = await executor(invocation.input);
        if (execResult.error) {
            execResult.error = redactSecrets(execResult.error).text;
        }

        // Step 5: Redact secrets from output
        const { text: redactedOutput, redactionCount: outputRedactions } = redactSecrets(execResult.output);
        if (outputRedactions > 0) {
            warnings.push({ code: 'SECRET_REDACTED', message: `${outputRedactions} suspected secret(s) redacted from output` });
        }

        // Step 6: Store large output behind content handle
        let inlineOutput = redactedOutput;
        let contentHandles: ContentHandle[] | undefined;
        let truncated = false;

        if (needsHandle(redactedOutput)) {
            const { inlineText, handle } = storeContent(redactedOutput);
            inlineOutput = inlineText + '\n\n... [truncated — use content handle ' + handle.id + ' to retrieve remaining ' + (handle.totalLines - inlineText.split('\n').length) + ' lines]';
            contentHandles = [handle];
            truncated = true;
        }

        const result: PolicyToolResult<TData> = {
            invocationId: invocation.invocationId,
            status: execResult.success ? 'success' : 'error',
            summary: execResult.error ?? (execResult.success ? 'Completed successfully' : 'Failed'),
            data: execResult.data as TData,
            warnings: warnings.length > 0 ? warnings : undefined,
            contentHandles,
            auditEventId: generateAuditEventId(),
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
            truncated,
            retryable: !execResult.success,
        };

        // Expose output via data for backward compatibility
        if (!execResult.data && inlineOutput) {
            result.data = inlineOutput as TData;
        }

        // Step 7: Record audit event
        recordAudit(auditLogger, invocation, {
            outcome: execResult.success ? 'success' : 'error',
            errorCategory: execResult.error,
            approvalDecision: decision.decision === 'allow' ? 'auto_allowed' : 'user_approved',
            riskClass: decision.riskClass,
            sanitizedInputs,
            durationMs: result.durationMs,
            auditEventId: result.auditEventId,
        });

        return result as PolicyToolResult<TData>;
    } catch (e) {
        const errorMsg = redactSecrets((e as Error).message).text;
        const result = finishResult(invocation, startedAt, startTime, {
            status: 'error',
            summary: errorMsg,
            outcome: 'error',
            errorCategory: 'INTERNAL_ERROR',
            warnings,
            sanitizedInputs,
            riskClass: decision.riskClass,
        });
        return result as PolicyToolResult<TData>;
    }
}

interface FinishOptions {
    status: PolicyToolResult<unknown>['status'];
    summary: string;
    outcome?: AuditEvent['outcome'];
    errorCategory?: string;
    approvalDecision?: AuditEvent['approvalDecision'];
    warnings?: ToolWarning[];
    sanitizedInputs?: Record<string, unknown>;
    riskClass?: RiskClass;
    data?: unknown;
    contentHandles?: ContentHandle[];
    truncated?: boolean;
    retryable?: boolean;
}

function finishResult<TData>(
    invocation: ToolInvocation,
    startedAt: string,
    startTime: number,
    opts: FinishOptions,
): PolicyToolResult<TData> {
    const durationMs = Date.now() - startTime;
    const auditEventId = generateAuditEventId();

    // Record audit
    recordAudit(getAuditLogger(), invocation, {
        outcome: opts.outcome ?? 'error',
        errorCategory: opts.errorCategory,
        approvalDecision: opts.approvalDecision,
        riskClass: opts.riskClass,
        sanitizedInputs: opts.sanitizedInputs ?? invocation.input as Record<string, unknown>,
        durationMs,
        auditEventId,
    });

    return {
        invocationId: invocation.invocationId,
        status: opts.status,
        summary: opts.summary,
        data: opts.data as TData,
        warnings: opts.warnings,
        contentHandles: opts.contentHandles,
        auditEventId,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs,
        truncated: opts.truncated,
        retryable: opts.retryable,
    };
}

function recordAudit(
    logger: AuditLogger,
    invocation: ToolInvocation,
    opts: {
        outcome: AuditEvent['outcome'];
        errorCategory?: string;
        approvalDecision?: AuditEvent['approvalDecision'];
        riskClass?: RiskClass;
        sanitizedInputs: Record<string, unknown>;
        durationMs: number;
        auditEventId: string;
    },
): void {
    const event: AuditEvent = {
        timestamp: new Date().toISOString(),
        eventId: opts.auditEventId,
        sessionId: invocation.sessionId,
        agentId: invocation.agentId,
        taskId: invocation.taskId,
        toolName: invocation.toolName,
        riskClass: opts.riskClass ?? 'R0',
        sanitizedInputs: opts.sanitizedInputs,
        approvalDecision: opts.approvalDecision,
        workspacePath: invocation.workspaceId,
        outcome: opts.outcome,
        errorCategory: opts.errorCategory,
        durationMs: opts.durationMs,
        policyVersion: '1.0.0',
    };
    logger.record(event);
}

/**
 * Serialize a PolicyToolResult into a model-readable string.
 * Includes warnings (prepended) and content handle references (appended).
 */
export function serializeForModel(result: PolicyToolResult): string {
    let output = typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? '');

    // Prepend warnings so the model sees them
    if (result.warnings && result.warnings.length > 0) {
        const warningText = result.warnings.map(w => `[WARNING ${w.code}]: ${w.message}`).join('\n');
        output = warningText + '\n' + output;
    }

    // Append content handle references
    if (result.contentHandles && result.contentHandles.length > 0) {
        const handleRefs = result.contentHandles.map(h => `[Content handle: ${h.id}]`).join(', ');
        output += '\n[Truncated output available via: ' + handleRefs + ']';
    }

    return output;
}

/**
 * Convert a rich PolicyToolResult back to the legacy format for backward compatibility.
 */
export function toLegacyResult<TData>(result: PolicyToolResult<TData>): { success: boolean; output: string; error?: string } {
    return {
        success: result.status === 'success',
        output: serializeForModel(result),
        error: result.status !== 'success' ? result.summary : undefined,
    };
}
