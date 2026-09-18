import * as vscode from 'vscode';
import { ParsedToolCall, ToolCall } from '../types';
import { toolRegistry } from './toolRegistry';
import { ToolDefinition } from './toolDefinitions';
import { ActiveModelConfig } from '../provider/modelManager';
import {
    executeWithEnvelope,
    generateInvocationId,
    toLegacyResult,
    getPolicyEngine,
} from './policyEngine';
import { RiskFactors, RiskClass, legacyRiskToClass, classifyRisk, isDenied, isDestructiveCommand, RISK_ORDER as RISK_CLASS_ORDER } from './riskModel';
import { configureContentHandles } from './contentHandle';
import { initApprovalStore, isAutoApproved as isWorkspaceAutoApproved, addRule } from './approvalStore';
import { isProtectedPath, commandReferencesProtectedPath, isAuditTrailPath, commandReferencesAuditTrail } from './pathSafety';
import { autoCheckpointBeforeDangerousCommand } from './checkpointManager';

// Risk level ordering for approval threshold comparison
const RISK_ORDER: Record<string, number> = { safe: 0, moderate: 1, dangerous: 2 };

/**
 * Collapse a fine-grained RiskClass (R0-R5) down to the legacy 3-tier scale
 * used for approval-threshold comparisons and allowlist keys. This is the
 * ESCALATED class (post argument-aware classification), not the tool's
 * static base risk — see computeEffectiveRisk().
 */
function riskClassToLegacyLevel(riskClass: RiskClass): 'safe' | 'moderate' | 'dangerous' {
    switch (riskClass) {
        case 'R0': return 'safe';
        case 'R1':
        case 'R2': return 'moderate';
        default: return 'dangerous'; // R3, R4, R5
    }
}

/**
 * Reconfigure the policy engine from current VS Code settings. Previously
 * this only ran once ever (a `_policyEngineConfigured` flag, set on first
 * call and never reset), so blocklist/output-limit setting changes were
 * silently ignored until the extension reloaded (H-5). Called on every
 * runTool() dispatch instead — cheap (a few config reads + one updateConfig
 * call, no I/O), so there's no real cost to keeping it always current.
 */
function ensurePolicyEngineConfigured(): void {
    const vsconfig = vscode.workspace.getConfiguration('codeon');
    const blocklist = vsconfig.get<string[]>('commandBlocklist') || ['rm -rf', ':(){ :|:};', 'mkfs', 'dd if='];

    // Reconfigure the global policy engine singleton with settings from VS Code
    const engine = getPolicyEngine();
    engine.updateConfig({
        trustedRequiredForExecution: true,
        autoApproveTargetedEdits: false,
        autoApproveSafeCommands: false,
        allowedCommandPatterns: [],
        blockedCommandPatterns: blocklist,
    });

    // Configure content handles (inline limit matches toolOutputMaxChars setting)
    const maxChars = vsconfig.get<number>('toolOutputMaxChars') || 15000;
    configureContentHandles({ maxInlineChars: Math.min(maxChars, 10_000) });
}

/** Session-level auto-approval: shared across all ToolCallHandler instances within a VS Code session.
 * Stores "toolName:riskLevel" keys. Lives at module level because a new handler is created per sendMessage. */
const sessionAllowlist = new Set<string>();

// M-7: sessionAllowlist was previously only cleared on new-chat/switch-chat,
// not on a workspace-folder change — a tool auto-approved in one workspace
// would stay auto-approved after adding/removing/switching workspace
// folders in the same window (a single-root folder switch normally restarts
// the extension host anyway, so this mainly matters for multi-root setups).
// Guarded: the lightweight `vscode` stub used to run unit tests under plain
// mocha doesn't implement this API, and module load must not crash there.
if (typeof vscode.workspace.onDidChangeWorkspaceFolders === 'function') {
    vscode.workspace.onDidChangeWorkspaceFolders(() => sessionAllowlist.clear());
}

export class ToolCallHandler {
    private toolCalls: ToolCall[] = [];
    private openCodeEnabled: boolean;
    private approvalThreshold: string;
    private webview: vscode.Webview | undefined;
    private abortController: AbortController | null = null;
    private currentMode: string = 'plan';
    private _modelConfig: ActiveModelConfig | undefined;
    /** Pending plan-mode block responses: toolId → resolve function */
    private _pendingPlanBlocks = new Map<string, (approved: boolean) => void>();
    /** Pending tool-approval responses: toolId → entry */
    private _pendingApprovals = new Map<string, { resolve: (approved: boolean) => void; timeoutHandle?: ReturnType<typeof setTimeout>; handler: unknown; disposable: vscode.Disposable }>();
    /** Workspace root for approval store initialization. */
    private _workspaceRoot: string | undefined;
    /** Whether the approval store was initialized for this instance. */
    private _approvalStoreInitialized = false;

    constructor(
        openCodeEnabled: boolean,
        approvalThreshold: string = 'moderate',
        _commandTimeout: number = 30,
        _commandBlocklist: string[] = ['rm -rf', ':(){ :|:};', 'mkfs', 'dd if=']
    ) {
        this.openCodeEnabled = openCodeEnabled;
        this.approvalThreshold = approvalThreshold;
    }

    /** Set the abort controller so tool execution can be cancelled. */
    setAbortController(controller: AbortController | null): void {
        this.abortController = controller;
        // Propagate the abort signal to executors that wait on user input
        // (e.g. ask_user_question), so pressing Stop / switching chats cancels
        // a pending question instead of leaving it hanging until a timeout.
        const signal = controller?.signal;
        for (const def of toolRegistry.allDefinitions()) {
            const executor = toolRegistry.getExecutor(def.name);
            if (executor && typeof (executor as unknown as Record<string, unknown>).setAbortSignal === 'function') {
                (executor as unknown as Record<string, (s: AbortSignal | undefined) => void>).setAbortSignal(signal);
            }
        }
    }

    /** Return true if cancellation was requested. */
    isAborted(): boolean {
        return this.abortController?.signal.aborted === true;
    }

    /** Change the approval threshold at runtime (from interaction mode dropdown). */
    setApprovalThreshold(threshold: string): void {
        this.approvalThreshold = threshold;
    }

    setWebview(webview: vscode.Webview): void {
        this.webview = webview;
        // Propagate webview to executors that need it (e.g., ask_user_question)
        for (const def of toolRegistry.allDefinitions()) {
            const executor = toolRegistry.getExecutor(def.name);
            if (executor && typeof (executor as unknown as Record<string, unknown>).setWebview === 'function') {
                (executor as unknown as Record<string, (webview: vscode.Webview) => void>).setWebview(webview);
            }
        }
    }

    /** Set the active model config so sub-agents inherit the same endpoint/key. */
    setModelConfig(config: ActiveModelConfig | undefined): void {
        this._modelConfig = config;
        for (const def of toolRegistry.allDefinitions()) {
            const executor = toolRegistry.getExecutor(def.name);
            if (executor && typeof (executor as unknown as Record<string, unknown>).setModelConfig === 'function') {
                (executor as unknown as Record<string, (config: ActiveModelConfig | undefined) => void>).setModelConfig(config);
            }
        }
    }

    /**
     * Set the chat ID this handler instance is servicing, so tools that manage
     * cross-turn state (currently: sub-agents) can scope their records to it
     * instead of leaking across chats (P5-T5). A new ToolCallHandler is
     * constructed per sendMessage() call, so this should be called once right
     * after construction, alongside setWebview/setModelConfig.
     */
    setChatId(chatId: string | undefined): void {
        for (const def of toolRegistry.allDefinitions()) {
            const executor = toolRegistry.getExecutor(def.name);
            if (executor && typeof (executor as unknown as Record<string, unknown>).setChatId === 'function') {
                (executor as unknown as Record<string, (chatId: string | undefined) => void>).setChatId(chatId);
            }
        }
    }

    /** Set the current chat mode (plan/build/etc). */
    setCurrentMode(mode: string): void {
        this.currentMode = mode;
    }

    /**
     * Give any executor that manages sub-agents (currently: spawn_agent) a
     * callback into this handler's own runTool path (P6-T14), so a sub-agent's
     * tool calls are risk-classified, approval-gated, audited, and
     * auto-checkpointed through the exact same logic as a tool call made by
     * the parent conversation — instead of the sub-agent's previous separate,
     * ungoverned dispatch straight to the executor. Follows the same
     * set-on-every-executor pattern as setWebview/setModelConfig/setChatId.
     */
    wireSubAgentToolExecution(): void {
        for (const def of toolRegistry.allDefinitions()) {
            const executor = toolRegistry.getExecutor(def.name);
            if (executor && typeof (executor as unknown as Record<string, unknown>).setExecuteTool === 'function') {
                (executor as unknown as Record<string, (fn: (agentId: string, name: string, args: Record<string, unknown>, allowedTools: string[]) => Promise<{ success: boolean; output: string; error?: string }>) => void>).setExecuteTool(
                    (agentId: string, name: string, args: Record<string, unknown>, allowedTools: string[]) => this.runToolForAgent(agentId, name, args, allowedTools)
                );
            }
        }
    }

    /**
     * Execute a tool call on behalf of a running sub-agent through the
     * identical risk classification / approval / audit / auto-checkpoint path
     * used for the parent conversation's own tool calls (P6-T14). The
     * approval card (if one is shown) is tagged with agentId so the UI can
     * attribute the request to the right agent. Session/workspace
     * auto-approval grants are shared process-wide (sessionAllowlist /
     * approvalStore), so a sub-agent automatically inherits whatever the user
     * already approved in the parent chat — no separate plumbing needed.
     *
     * C-2: SubAgentLoop already checks the tool is within its own allowlist
     * before ever calling this (so today's only caller can't reach this with
     * an out-of-scope tool), but that enforcement previously lived entirely
     * in the caller's discipline — any future call site that skipped it would
     * silently reopen unrestricted tool access for a sub-agent. allowedTools
     * is threaded through from the agent's own record (see agentOrchestrator.ts)
     * so the check is enforced here too, defense-in-depth.
     */
    public async runToolForAgent(
        agentId: string,
        name: string,
        args: Record<string, unknown>,
        allowedTools: string[]
    ): Promise<{ success: boolean; output: string; error?: string }> {
        if (!allowedTools.includes(name)) {
            return { success: false, output: '', error: `Tool '${name}' is not in this agent's allowlist` };
        }

        const { riskLevel, riskClass } = this.computeEffectiveRisk(name, args);

        // A call the policy engine will deny unconditionally (R5) is never
        // worth prompting for — see the identical reasoning in executeToolCall.
        if (isDenied(riskClass)) {
            return this.runTool(name, args, false, agentId);
        }

        let alreadyApproved = false;
        if (this.needsApproval(riskLevel, name)) {
            const approved = await this.requestApproval(
                { id: `${agentId}:${generateInvocationId()}`, name, arguments: args },
                riskLevel,
                riskClass,
                agentId
            );
            if (!approved) {
                return { success: false, output: '', error: `Tool ${name} was rejected by user` };
            }
            alreadyApproved = true;
        } else if (riskLevel !== 'safe') {
            // Not prompted because a session/workspace rule already covers this
            // exact (escalated) risk level — treat as approved for runTool.
            alreadyApproved = true;
        }

        return this.runTool(name, args, alreadyApproved, agentId);
    }

    /** Initialize the approval store for the workspace. Call once per session. */
    initWorkspace(workspaceRoot: string): void {
        this._workspaceRoot = workspaceRoot;
        if (!this._approvalStoreInitialized) {
            initApprovalStore(workspaceRoot);
            this._approvalStoreInitialized = true;
        }
    }

    /** Clear the session-level allowlist (called when starting a new chat). */
    clearSessionAllowlist(): void {
        sessionAllowlist.clear();
    }

    /** Resolve a pending plan-mode block (called from chatViewProvider when webview responds). */
    resolvePlanBlock(toolId: string, approved: boolean): void {
        const resolve = this._pendingPlanBlocks.get(toolId);
        if (resolve) {
            resolve(approved);
            this._pendingPlanBlocks.delete(toolId);
        }
    }

    /** Check if a tool is allowed in plan mode (only R0 tools). */
    private isToolAllowedInPlanMode(name: string): boolean {
        return toolRegistry.isParallelSafe(name);
    }

    /**
     * Compute the ARGUMENT-AWARE effective risk for a tool call — the risk class
     * after escalation rules (protected paths, destructive commands, secret access,
     * etc.) have been applied to the specific arguments, not just the tool's static
     * base risk level.
     *
     * This must be used for every approval decision (threshold check, session/workspace
     * allowlist matching, and the `alreadyApproved` flag passed into runTool). Using the
     * static tool-level riskLevel instead would let a call escalated by its arguments
     * (e.g. write_file targeting .env) slip through on an approval granted for a
     * lower-risk call to the same tool name.
     */
    private computeEffectiveRisk(toolName: string, args: Record<string, unknown>): { riskLevel: 'safe' | 'moderate' | 'dangerous'; riskClass: RiskClass } {
        const toolDef = toolRegistry.getDefinition(toolName);
        const riskFactors = buildRiskFactors(toolDef, args);
        const riskClass = classifyRisk(riskFactors);
        return { riskLevel: riskClassToLegacyLevel(riskClass), riskClass };
    }

    /** Request user to exit plan mode for a blocked tool. */
    private async requestPlanModeExit(toolCall: ParsedToolCall): Promise<boolean> {
        if (!this.webview) return false;

        return new Promise<boolean>(resolve => {
            this._pendingPlanBlocks.set(toolCall.id, resolve);

            this.webview!.postMessage({
                command: 'planModeToolBlocked',
                toolId: toolCall.id,
                toolName: toolCall.name,
            });

            // Timeout after 60 seconds
            setTimeout(() => {
                this._pendingPlanBlocks.delete(toolCall.id);
                resolve(false);
            }, 60000);
        });
    }

    async executeToolCall(toolCall: ParsedToolCall): Promise<{ success: boolean; output: string; error?: string }> {
        if (!this.openCodeEnabled) {
            throw new Error('OpenCode integration is disabled');
        }

        const tracked: ToolCall = {
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
            status: 'executing'
        };
        this.toolCalls.push(tracked);

        try {
            // Check if tool needs approval based on the argument-aware effective risk
            // (not just the tool's static riskLevel — see computeEffectiveRisk).
            const { riskLevel, riskClass } = this.computeEffectiveRisk(toolCall.name, toolCall.arguments);
            let alreadyApproved = false;

            // A call the policy engine will deny unconditionally (R5) is never
            // worth prompting for — the answer can't change the outcome, and
            // waiting on a user response for something already decided would
            // just hang the turn. Let it fall through to runTool, which enforces
            // the deny regardless of alreadyApproved.
            if (isDenied(riskClass)) {
                const result = await this.runTool(toolCall.name, toolCall.arguments, false);
                tracked.status = 'completed';
                tracked.result = result;
                return result;
            }

            if (this.needsApproval(riskLevel, toolCall.name)) {
                const approved = await this.requestApproval(toolCall, riskLevel, riskClass);
                if (!approved) {
                    tracked.status = 'completed';
                    tracked.result = { success: false, output: '', error: `Tool ${toolCall.name} was rejected by user` };
                    return { success: false, output: '', error: `Tool ${toolCall.name} was rejected by user` };
                }
                alreadyApproved = true;
            } else if (riskLevel !== 'safe') {
                // Not prompted because a session/workspace rule already covers this
                // exact (escalated) risk level — treat as approved for runTool.
                alreadyApproved = true;
            }

            const result = await this.runTool(toolCall.name, toolCall.arguments, alreadyApproved);
            tracked.status = 'completed';
            tracked.result = result;
            return result;
        } catch (error) {
            tracked.status = 'failed';
            tracked.result = (error as Error).message;
            throw error;
        }
    }

    /** Check if a risk level requires approval based on threshold, session allowlist, and workspace rules. */
    private needsApproval(riskLevel: string, toolName?: string): boolean {
        const riskVal = RISK_ORDER[riskLevel] ?? 0;
        const thresholdVal = RISK_ORDER[this.approvalThreshold] ?? 1;
        if (riskVal < thresholdVal) return false;

        // Check session-level allowlist
        if (toolName && sessionAllowlist.has(`${toolName}:${riskLevel}`)) {
            return false;
        }

        // Check workspace-level rules
        if (toolName && isWorkspaceAutoApproved(toolName, riskLevel)) {
            return false;
        }

        return true;
    }

    /** Request user approval via webview message protocol. */
    private async requestApproval(toolCall: ParsedToolCall, riskLevel: string, riskClassOverride?: RiskClass, agentId?: string): Promise<boolean> {
        if (!this.webview) {
            return false;
        }

        // Compute risk class for display — prefer the precomputed, argument-aware
        // class (riskClassOverride) over the tool's static base riskClass.
        const toolDef = toolRegistry.getDefinition(toolCall.name);
        const riskClass = riskClassOverride ?? toolDef?.riskClass ?? legacyRiskToClass(riskLevel as 'safe' | 'moderate' | 'dangerous');

        return new Promise<boolean>(resolve => {
            let resolved = false;

            const doResolve = (value: boolean) => {
                if (resolved) return;
                resolved = true;
                resolve(value);
            };

            const disposable = vscode.window.onDidChangeWindowState(() => {});

            this.webview!.postMessage({
                command: 'toolApprovalRequest',
                toolId: toolCall.id,
                toolName: toolCall.name,
                args: JSON.stringify(toolCall.arguments),
                riskLevel,
                riskClass,
                agentId,
            });

            // Approval card is rendered inline in the chat webview — no separate
            // VS Code toast needed (it appeared as a duplicate request to users).

            // No timeout — approvals persist until the user responds in the chat.
            // The model waits; it never auto-rejects on its own.
            // M-9: store the full args (not just toolName/riskLevel) so a
            // webview reinit before the user responds can repost the real
            // arguments instead of an empty '{}' — approving blind after a
            // reload was the previous behavior.
            this._pendingApprovals.set(toolCall.id, {
                resolve: doResolve,
                timeoutHandle: undefined,
                handler: { toolName: toolCall.name, riskLevel, args: toolCall.arguments },
                disposable,
            });
        });
    }

    /** Return the number of currently pending tool approvals. */
    public getPendingApprovalCount(): number {
        return this._pendingApprovals.size;
    }

    /** Resolve a pending approval (called from chatViewProvider when webview responds). */
    resolveApproval(toolId: string, approved: boolean, scope?: 'once' | 'session' | 'workspace'): void {
        if (!this._pendingApprovals.has(toolId)) {
            console.warn(`[ToolCallHandler] Approval response for unknown toolId '${toolId}'. Pending: ${Array.from(this._pendingApprovals.keys()).join(', ') || '(none)'}`);
            return;
        }

        const entry = this._pendingApprovals.get(toolId)!;
        entry.resolve(approved);
        if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
        if (entry.disposable) entry.disposable.dispose();
        this._pendingApprovals.delete(toolId);

        // Apply scoped auto-approval if approved
        if (approved && scope !== 'once') {
            // Extract tool info from the message handler context
            const handler = entry.handler as Record<string, unknown> | undefined;
            const toolName = String(handler?.toolName || '');
            const riskLevel = String(handler?.riskLevel || '');

            if (scope === 'session' && toolName && riskLevel) {
                sessionAllowlist.add(`${toolName}:${riskLevel}`);
            } else if (scope === 'workspace' && toolName && riskLevel) {
                addRule(toolName, riskLevel);
            }
        }
    }

    /** Re-post all pending approval requests to a fresh webview after reinit. */
    public repostPendingApprovals(webview: vscode.Webview | undefined): void {
        if (!webview || this._pendingApprovals.size === 0) return;

        // Update the stored webview reference in case it changed
        this.webview = webview;

        for (const [toolId, entry] of this._pendingApprovals) {
            const handler = entry.handler as Record<string, unknown> | undefined;
            const toolName = String(handler?.toolName || '');
            const riskLevel = String(handler?.riskLevel || 'moderate');
            // M-9: repost the real args captured when the approval was first
            // requested, instead of '{}' — the user should see what they're
            // actually approving, not approve blind after a webview reinit.
            const args = (handler?.args as Record<string, unknown> | undefined) ?? {};

            // Re-fetch the tool definition for args and riskClass
            const toolDef = toolRegistry.getDefinition(toolName);
            const riskClass = toolDef?.riskClass ?? legacyRiskToClass(riskLevel as 'safe' | 'moderate' | 'dangerous');

            webview.postMessage({
                command: 'toolApprovalRequest',
                toolId,
                toolName,
                args: JSON.stringify(args),
                riskLevel,
                riskClass,
            });
        }
    }

    /** Resolve a pending question (called from chatViewProvider when webview responds). */
    resolveQuestion(questionId: string, answer: unknown): void {
        const executor = toolRegistry.getExecutor('ask_user_question');
        if (executor && typeof (executor as unknown as Record<string, unknown>).resolveQuestion === 'function') {
            (executor as unknown as Record<string, (questionId: string, answer: unknown) => void>).resolveQuestion(questionId, answer);
        }
    }

    getToolCalls(): ToolCall[] {
        return [...this.toolCalls];
    }

    /**
     * Execute multiple tool calls, running independent reads in parallel.
     */
    async executeToolCallsBatch(
        toolCalls: ParsedToolCall[]
    ): Promise<Array<{ success: boolean; output: string; error?: string; autoApprovedBy?: 'session' | 'workspace' }>> {
        // In plan mode, always use sequential execution so that plan-mode blocking
        // and risk-based approval dialogs can present one tool at a time.
        if (this.currentMode === 'plan') {
            return this.executeSequential(toolCalls);
        }

        const allParallelSafe = toolCalls.every(tc => toolRegistry.isParallelSafe(tc.name));

        if (allParallelSafe && toolCalls.length > 1) {
            return this.executeParallel(toolCalls);
        }

        return this.executeSequential(toolCalls);
    }

    /** Execute all tool calls concurrently via Promise.all. */
    private async executeParallel(
        toolCalls: ParsedToolCall[]
    ): Promise<Array<{ success: boolean; output: string; error?: string; autoApprovedBy?: 'session' | 'workspace' }>> {
        if (this.isAborted()) return [];

        // Check approval for any tool that needs it before running in parallel.
        // Plan mode should never reach here (executeToolCallsBatch forces sequential),
        // but guard anyway.
        const rejected = new Set<string>();
        const approvedTools = new Set<string>();
        for (const tc of toolCalls) {
            if (this.currentMode === 'plan' && !this.isToolAllowedInPlanMode(tc.name)) {
                const approved = await this.requestPlanModeExit(tc);
                if (!approved) rejected.add(tc.id);
            }

            const { riskLevel, riskClass } = this.computeEffectiveRisk(tc.name, tc.arguments);
            if (!rejected.has(tc.id) && this.needsApproval(riskLevel, tc.name)) {
                const approved = await this.requestApproval(tc, riskLevel, riskClass);
                if (!approved) rejected.add(tc.id);
                else approvedTools.add(tc.id);
            }
        }

        const promises = toolCalls.map(async (tc): Promise<{ success: boolean; output: string; error?: string; autoApprovedBy?: 'session' | 'workspace' }> => {
            const tracked: ToolCall = {
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                status: 'executing',
            };
            this.toolCalls.push(tracked);

            if (rejected.has(tc.id)) {
                tracked.status = 'completed';
                const result = { success: false, output: '', error: `Tool ${tc.name} was blocked` };
                tracked.result = result;
                return result;
            }

            try {
                let alreadyApproved = approvedTools.has(tc.id);
                let autoApprovedBy: 'session' | 'workspace' | null = null;
                if (!alreadyApproved) {
                    // Re-derive the effective risk here (not the pre-loop value) so an
                    // allowlist match is checked against the same escalated class that
                    // will actually be evaluated inside runTool.
                    const { riskLevel } = this.computeEffectiveRisk(tc.name, tc.arguments);
                    if (riskLevel !== 'safe' && tc.name) {
                        if (sessionAllowlist.has(`${tc.name}:${riskLevel}`)) {
                            autoApprovedBy = 'session';
                        } else if (isWorkspaceAutoApproved(tc.name, riskLevel)) {
                            autoApprovedBy = 'workspace';
                        }
                    }
                    // Auto-approval from session/workspace also bypasses the policy engine
                    if (autoApprovedBy) {
                        alreadyApproved = true;
                    }
                }
                const result = await this.runTool(tc.name, tc.arguments, alreadyApproved);
                tracked.status = 'completed';
                tracked.result = result;
                const toolResult: { success: boolean; output: string; error?: string; autoApprovedBy?: 'session' | 'workspace' } = { ...result };
                if (autoApprovedBy) {
                    toolResult.autoApprovedBy = autoApprovedBy;
                }
                return toolResult;
            } catch (error) {
                tracked.status = 'failed';
                tracked.result = (error as Error).message;
                return { success: false, output: '', error: (error as Error).message };
            }
        });

        return Promise.all(promises);
    }

    /** Execute tool calls one-by-one. */
    private async executeSequential(
        toolCalls: ParsedToolCall[]
    ): Promise<Array<{ success: boolean; output: string; error?: string; autoApprovedBy?: 'session' | 'workspace' }>> {
        type ToolResult = { success: boolean; output: string; error?: string; autoApprovedBy?: 'session' | 'workspace' };
        const results: ToolResult[] = [];

        for (const tc of toolCalls) {
            if (this.isAborted()) {
                results.push({ success: false, output: '', error: 'Aborted by user' });
                continue;
            }

            const tracked: ToolCall = {
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                status: 'executing',
            };
            this.toolCalls.push(tracked);

            try {
                // Plan mode: block non-R0 tools, ask user to exit plan mode first
                let planModeApproved = false;
                if (this.currentMode === 'plan' && !this.isToolAllowedInPlanMode(tc.name)) {
                    const approved = await this.requestPlanModeExit(tc);
                    if (!approved) {
                        tracked.status = 'completed';
                        tracked.result = { success: false, output: '', error: `Tool ${tc.name} blocked in plan mode` };
                        results.push({ success: false, output: '', error: `Tool ${tc.name} blocked in plan mode` });
                        continue;
                    }
                    planModeApproved = true;
                }

                const { riskLevel, riskClass } = this.computeEffectiveRisk(tc.name, tc.arguments);

                // A call the policy engine will deny unconditionally (R5) is never
                // worth prompting for — see the matching comment in executeToolCall.
                if (!planModeApproved && isDenied(riskClass)) {
                    const result = await this.runTool(tc.name, tc.arguments, false);
                    tracked.status = 'completed';
                    tracked.result = result;
                    results.push(result);
                    continue;
                }

                // Skip normal approval if the user already approved by exiting plan mode
                let alreadyApproved = false;
                let autoApprovedBy: 'session' | 'workspace' | null = null;
                if (!planModeApproved && this.needsApproval(riskLevel, tc.name)) {
                    const approved = await this.requestApproval(tc, riskLevel, riskClass);
                    if (!approved) {
                        tracked.status = 'completed';
                        tracked.result = { success: false, output: '', error: `Tool ${tc.name} was rejected by user` };
                        results.push({ success: false, output: '', error: `Tool ${tc.name} was rejected by user` });
                        continue;
                    }
                    alreadyApproved = true;
                } else if (!planModeApproved && !this.needsApproval(riskLevel, tc.name) && riskLevel !== 'safe') {
                    // Tool was auto-approved by session or workspace rule (not safe/R0)
                    if (tc.name && sessionAllowlist.has(`${tc.name}:${riskLevel}`)) {
                        autoApprovedBy = 'session';
                    } else if (tc.name && isWorkspaceAutoApproved(tc.name, riskLevel)) {
                        autoApprovedBy = 'workspace';
                    }
                    // Mark as already approved so the policy engine doesn't request again
                    if (autoApprovedBy) {
                        alreadyApproved = true;
                    }
                }

                const result = await this.runTool(tc.name, tc.arguments, alreadyApproved);
                tracked.status = 'completed';
                tracked.result = result;
                const toolResult: ToolResult = { ...result };
                if (autoApprovedBy) {
                    toolResult.autoApprovedBy = autoApprovedBy;
                }
                results.push(toolResult);
            } catch (error) {
                tracked.status = 'failed';
                tracked.result = (error as Error).message;
                results.push({ success: false, output: '', error: (error as Error).message });
            }
        }

        return results;
    }

    /** Dispatch to the registered executor for a tool by name, wrapped in the policy engine envelope. */
    private async runTool(name: string, args: Record<string, unknown>, alreadyApproved = false, agentId?: string): Promise<{ success: boolean; output: string; error?: string }> {
        // Ensure policy engine is configured with current VS Code settings
        ensurePolicyEngineConfigured();

        const executor = toolRegistry.getExecutor(name);
        if (!executor) {
            return { success: false, output: '', error: `Unknown tool: ${name}` };
        }

        const toolDef = toolRegistry.getDefinition(name);

        // Build risk factors from tool definition + input context — the same
        // deterministic computation used by computeEffectiveRisk() at the call
        // site, so this fallback callback's displayed risk always matches what
        // was actually approved (or needs approving).
        const riskFactors = buildRiskFactors(toolDef, args);
        const effectiveRiskClass = classifyRisk(riskFactors);

        // Build invocation record. agentId (when set) tags this as a sub-agent's
        // tool call rather than the parent conversation's own, for the audit log.
        const invocation = {
            invocationId: generateInvocationId(),
            toolName: name,
            input: args,
            workspaceId: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'unknown',
            agentId,
            sessionId: Date.now().toString(36),
            requestedAt: new Date().toISOString(),
        };

        // P5-T17: before a destructive shell command actually runs, snapshot the
        // workspace's dirty files so their state can be recovered afterward. Only
        // for execute_command at R3+ (the escalated, destructive tier). Awaited
        // but best-effort — a checkpoint failure must not block the command.
        if (name === 'execute_command' && RISK_CLASS_ORDER[effectiveRiskClass] >= RISK_CLASS_ORDER['R3']) {
            try {
                const cp = await autoCheckpointBeforeDangerousCommand(String(args.command || ''));
                if (cp) {
                    console.log(`[checkpoint] Auto-snapshot ${cp.id} before dangerous command (${Object.keys(cp.files).length} file(s))`);
                }
            } catch { /* never block the command on a checkpoint failure */ }
        }

        // Execute through policy envelope
        const result = await executeWithEnvelope(invocation, riskFactors,
            // Approval callback — delegates to existing webview approval flow.
            // This only fires when alreadyApproved is false, i.e. the caller
            // didn't already clear this exact (escalated) risk class.
            async () => {
                const approved = await this.requestApproval(
                    { id: invocation.invocationId, name, arguments: args },
                    riskClassToLegacyLevel(effectiveRiskClass),
                    effectiveRiskClass,
                    agentId
                );
                return approved;
            },
            // Executor wrapper
            async (input: Record<string, unknown>) => {
                return executor.execute(input);
            },
            alreadyApproved
        );

        // Convert rich PolicyToolResult back to legacy format
        return toLegacyResult(result);
    }
}

/**
 * Build RiskFactors from a tool definition and invocation arguments.
 * Evaluates dynamic risk based on both the tool's base risk class and the
 * specific inputs (e.g., destructive commands, protected paths).
 */
function buildRiskFactors(toolDef: ToolDefinition | undefined, args: Record<string, unknown>): RiskFactors {
    const baseRisk: RiskClass = toolDef?.riskClass ?? legacyRiskToClass(toolDef?.riskLevel || 'safe');

    const factors: RiskFactors = { baseRisk };

    // Command-based risk evaluation for execute_command
    if (toolDef?.name === 'execute_command') {
        const command = String(args.command || '');
        factors.command = command;

        // Destructiveness is derived from the single shared DESTRUCTIVE_PATTERNS
        // list in riskModel (not a second inline copy) so hardening that list in
        // one place can't leave this check on a stale, narrower definition.
        // (classifyRisk also re-checks `command` against the same list; setting
        // the flag here keeps the two consistent instead of relying on that.)
        factors.isDestructive = isDestructiveCommand(command);

        // Detect deployment/production patterns
        const prodPatterns = [/deploy.*prod/i, /kubectl\s+apply/i, /terraform\s+apply/i];
        if (prodPatterns.some(p => p.test(command))) {
            factors.hasExternalVisibility = true;
        }

        // P5-T2: shell access to a protected/sensitive file (e.g. `cat ~/.ssh/id_rsa`,
        // `cp .env /tmp/x`) must escalate the same way a direct write_file/edit_file
        // call to that path would — this was previously unguarded for execute_command.
        if (commandReferencesProtectedPath(command)) {
            factors.targetsProtectedPath = true;
        }

        // P5-T3: the audit log / approval-rules store is denied outright, not
        // just escalated to an approvable tier — see targetsAuditTrail in riskModel.
        if (commandReferencesAuditTrail(command)) {
            factors.targetsAuditTrail = true;
        }
    }

    // Path-based risk evaluation for file tools — uses the same canonical
    // protected-path list (pathSafety.isProtectedPath) that writeFile/editFile/
    // applyMultiEdit already hard-block on, so risk scoring and the hard block
    // can't drift apart into two different definitions of "protected."
    if (toolDef?.name && ['edit_file', 'write_file', 'apply_patch'].includes(toolDef.name)) {
        const filePath = String(args.path || '');
        factors.targetsProtectedPath = isProtectedPath(filePath) || /\.git\b/.test(filePath);
        if (isAuditTrailPath(filePath)) {
            factors.targetsAuditTrail = true;
        }
    }

    // apply_multi_edit touches multiple files in one call — scan every target
    // path so a batch that includes .codeon/ among other, ordinary files
    // can't slip the audit-trail protection past a single-path check.
    if (toolDef?.name === 'apply_multi_edit' && Array.isArray(args.edits)) {
        const editPaths = (args.edits as Array<Record<string, unknown>>)
            .map(e => String(e?.path || ''))
            .filter(Boolean);
        if (editPaths.some(p => isAuditTrailPath(p))) {
            factors.targetsAuditTrail = true;
        }
        if (editPaths.some(p => isProtectedPath(p))) {
            factors.targetsProtectedPath = true;
        }
    }

    // Git history modification detection
    if (toolDef?.name && ['git_commit', 'git_restore', 'git_branch'].includes(toolDef.name)) {
        factors.modifiesHistory = true;
    }

    // Secret access detection
    if (toolDef?.name === 'read_env_value') {
        const envName = String(args.name || '');
        const sensitivePatterns = [/TOKEN/i, /PASSWORD/i, /SECRET/i, /API_KEY/i, /PRIVATE.?KEY/i];
        factors.accessesSecrets = sensitivePatterns.some(p => p.test(envName));
    }

    // External visibility for MCP tool invocations only.
    // web_search and web_fetch are excluded — they are read-only operations
    // already controllable via interaction mode (ask/autoedit/relaxed).
    // Escalating them to R4 via hasExternalVisibility created a mismatch
    // with the static riskLevel used by the approval system.
    if (toolDef?.name === 'invoke_mcp_tool') {
        factors.hasExternalVisibility = true;
    }

    return factors;
}
