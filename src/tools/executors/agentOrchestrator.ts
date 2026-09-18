import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { SubAgentLoop } from '../../agents/subAgentLoop';
import { ActiveModelConfig } from '../../provider/modelManager';

/** Possible states of a managed subagent. */
export type AgentStatus = 'running' | 'paused' | 'completed' | 'error' | 'stopped';

/** Internal representation of a managed subagent. */
interface AgentRecord {
    id: string;
    prompt: string;
    status: AgentStatus;
    toolAllowlist: string[];
    worktree?: string;
    createdAt: number;
    lastActivity: number;
    messages: string[];
    toolUsageCount: number;
    error?: string;
    /**
     * The chat that spawned this agent (P5-T5). AgentManager is a process-wide
     * singleton shared across every saved chat, so this is what scopes an
     * agent's visibility/ownership to its own conversation — without it, a
     * background agent's progress can render into whichever chat happens to
     * be active when its next event fires, and one chat's agent tools could
     * query/stop another chat's agent by ID.
     */
    chatId?: string;
    /** Pending messages queued by send_agent_message, drained by the SubAgentLoop between turns. */
    _pendingMessages: string[];
    /** Background promise for the running SubAgentLoop (set by SpawnAgentExecutor). */
    _loopPromise?: Promise<any>;
    /** AbortController to cancel a running agent loop (set by SpawnAgentExecutor). */
    _abortController?: AbortController;
    /** Partial output streamed from the agent during execution (updated via onProgress). */
    _partialOutput?: string;
}

/** How long a terminal-state (completed/error/stopped) agent record is kept before eviction. */
const TERMINAL_AGENT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Singleton manager for subagent lifecycle.
 * Agents are stored in memory only and are not persisted across sessions.
 * The actual LLM conversation loop integration is reserved for future implementation.
 */
class AgentManager {
    private agents = new Map<string, AgentRecord>();

    /** Maximum number of concurrently running agents. */
    public maxConcurrent: number = 3;

    /** Generate a short unique ID for a new agent. */
    private generateId(): string {
        return 'agent-' + Math.random().toString(36).slice(2, 10);
    }

    /**
     * Count currently running (non-terminal) agents. Scoped to a single chat
     * when chatId is given (P5-T5) — the concurrency cap exists to bound how
     * much is running at once, and a busy chat shouldn't be able to starve
     * agent spawning in a different, unrelated conversation.
     */
    private activeCount(chatId?: string): number {
        let count = 0;
        for (const a of this.agents.values()) {
            if (a.status !== 'running' && a.status !== 'paused') continue;
            if (chatId !== undefined && a.chatId !== chatId) continue;
            count++;
        }
        return count;
    }

    /**
     * Evict terminal-state agents older than TERMINAL_AGENT_TTL_MS. Called
     * opportunistically on spawn() rather than on a timer, since agents are
     * in-memory-only and there's no persistent process to schedule cleanup in.
     */
    private _evictStaleAgents(): void {
        const cutoff = Date.now() - TERMINAL_AGENT_TTL_MS;
        for (const [id, agent] of this.agents) {
            const isTerminal = agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped';
            if (isTerminal && agent.lastActivity < cutoff) {
                this.agents.delete(id);
            }
        }
    }

    /**
     * Create a new agent entry.
     * Returns the agent record on success, or an error string if the concurrency limit is reached.
     */
    public spawn(prompt: string, toolAllowlist: string[], worktree: string | undefined, chatId: string | undefined): AgentRecord | string {
        this._evictStaleAgents();

        if (this.activeCount(chatId) >= this.maxConcurrent) {
            return `CONCURRENCY_LIMIT: Maximum ${this.maxConcurrent} concurrent agents reached. Stop or wait for an agent before spawning a new one.`;
        }

        const now = Date.now();
        const agent: AgentRecord = {
            id: this.generateId(),
            prompt,
            status: 'running',
            toolAllowlist,
            worktree,
            chatId,
            createdAt: now,
            lastActivity: now,
            messages: [prompt],
            toolUsageCount: 0,
            _pendingMessages: [],
        };

        this.agents.set(agent.id, agent);
        return agent;
    }

    /**
     * Get an agent record scoped to the requesting chat (P5-T5). Returns
     * undefined if the agent doesn't exist OR belongs to a different chat, so
     * a tool call from one conversation can't query/message/stop another
     * conversation's agent — from the caller's side this is indistinguishable
     * from AGENT_NOT_FOUND, which avoids leaking that the other agent exists.
     * Agents with no chatId (spawned before chat scoping applied to them, or
     * from an internal call site that doesn't track one) remain unscoped.
     */
    public getOwnedAgent(agentId: string, chatId: string | undefined): AgentRecord | undefined {
        const agent = this.agents.get(agentId);
        if (!agent) return undefined;
        if (agent.chatId !== undefined && agent.chatId !== chatId) return undefined;
        return agent;
    }

    /** Stop and remove every agent belonging to a chat (e.g. on conversation reset). */
    public clearChatAgents(chatId: string): void {
        for (const [id, agent] of this.agents) {
            if (agent.chatId !== chatId) continue;
            if (agent._abortController) agent._abortController.abort();
            this.agents.delete(id);
        }
    }

    /** Queue a message for an agent. Returns false if the agent is not found or in a terminal state. */
    public sendMessage(agentId: string, message: string): boolean {
        const agent = this.agents.get(agentId);
        if (!agent) return false;
        if (agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped') return false;

        agent._pendingMessages.push(message);
        agent.messages.push(message);
        agent.lastActivity = Date.now();
        return true;
    }

    /** Drain pending messages for an agent (called by SubAgentLoop between turns). Returns consumed messages. */
    public drainPendingMessages(agentId: string): string[] {
        const agent = this.agents.get(agentId);
        if (!agent) return [];
        const pending = agent._pendingMessages;
        agent._pendingMessages = [];
        return pending;
    }

    /** Get an agent record by ID, or undefined. */
    public getAgent(agentId: string): AgentRecord | undefined {
        return this.agents.get(agentId);
    }

    /**
     * Wait for an agent to reach a terminal state.
     * Polls at the given interval until timeout or terminal status.
     */
    public async waitForAgent(agentId: string, timeoutMs: number, pollIntervalMs: number = 500): Promise<AgentRecord | 'timeout'> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const agent = this.agents.get(agentId);
            if (!agent) return 'timeout';

            if (agent.status === 'completed' || agent.status === 'error' || agent.status === 'stopped') {
                return agent;
            }

            // Wait for the next poll
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        return 'timeout';
    }

    /** Stop an agent. Returns false if not found. */
    public stopAgent(agentId: string): boolean {
        const agent = this.agents.get(agentId);
        if (!agent) return false;

        // Abort the running sub-agent loop if one exists
        if (agent._abortController) {
            agent._abortController.abort();
        }

        agent.status = 'stopped';
        agent.lastActivity = Date.now();
        return true;
    }

    /** List all agents (for internal use / debugging). */
    public listAgents(): AgentRecord[] {
        return [...this.agents.values()];
    }
}

/** Global singleton — shared across all agent-related executors. */
const agentManager = new AgentManager();

/** Access the global agent manager from outside this module. */
export function getAgentManager(): typeof agentManager {
    return agentManager;
}

/** Format an agent record into a summary object safe for JSON serialization. */
function agentSummary(agent: AgentRecord): Record<string, unknown> {
    return {
        id: agent.id,
        prompt: agent.prompt.slice(0, 500),
        status: agent.status,
        toolAllowlist: agent.toolAllowlist,
        worktree: agent.worktree,
        createdAt: agent.createdAt,
        lastActivity: agent.lastActivity,
        messageCount: agent.messages.length,
        toolUsageCount: agent.toolUsageCount,
        error: agent.error,
        partialOutput: agent._partialOutput || '',
    };
}

/**
 * Executor for the `spawn_agent` tool.
 * Creates a new subagent with restricted capabilities, stores it in the AgentManager,
 * and starts a real LLM-powered SubAgentLoop in the background.
 */
export class SpawnAgentExecutor implements ToolExecutor {
    public name = 'spawn_agent';

    private _webview: vscode.Webview | undefined;
    private _modelConfig: ActiveModelConfig | undefined;
    private _chatId: string | undefined;
    /**
     * Callback into the parent ToolCallHandler's own runTool path (P6-T14),
     * wired via ToolCallHandler.wireSubAgentToolExecution(). When set, every
     * tool call a spawned sub-agent makes is risk-classified, approval-gated,
     * audited, and auto-checkpointed identically to a tool call made by the
     * parent conversation, instead of dispatching straight to the executor
     * with no oversight.
     */
    private _executeTool: ((agentId: string, name: string, args: Record<string, unknown>, allowedTools: string[]) => Promise<{ success: boolean; output: string; error?: string }>) | undefined;

    setWebview(webview: vscode.Webview): void {
        this._webview = webview;
    }

    setModelConfig(config: ActiveModelConfig | undefined): void {
        this._modelConfig = config;
    }

    setChatId(chatId: string | undefined): void {
        this._chatId = chatId;
    }

    setExecuteTool(fn: (agentId: string, name: string, args: Record<string, unknown>, allowedTools: string[]) => Promise<{ success: boolean; output: string; error?: string }>): void {
        this._executeTool = fn;
    }

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const prompt = String(args.prompt || '');
            const toolAllowlistRaw = args.toolAllowlist ? String(args.toolAllowlist) : '';
            const worktree = args.worktree ? String(args.worktree) : undefined;
            // Optional overrides for the auto-computed turn/timeout budget
            // below. The auto-computation scales with toolAllowlist.length,
            // which is a weak proxy for actual task size — a well-scoped
            // agent given only 2-3 tools (as the toolAllowlist description
            // itself encourages) gets the SAME small budget whether it's
            // pointed at a handful of files or an entire large directory.
            // Only the caller (this model) knows which case it's in, so let
            // it ask for more room explicitly rather than guessing a bigger
            // constant that's still wrong for some other task shape.
            const maxTurns = args.maxTurns !== undefined ? Math.max(1, Math.min(100, Number(args.maxTurns))) : undefined;
            const timeoutMs = args.timeoutMs !== undefined ? Math.max(10_000, Math.min(1_800_000, Number(args.timeoutMs))) : undefined;

            if (!prompt) {
                return { success: false, output: '', error: 'Missing required parameter: prompt' };
            }

            const toolAllowlist = toolAllowlistRaw
                .split(',')
                .map(t => t.trim())
                .filter(t => t.length > 0);

            const chatId = this._chatId;
            const result = agentManager.spawn(prompt, toolAllowlist, worktree, chatId);

            if (typeof result === 'string') {
                return { success: false, output: '', error: result };
            }

            const agent = result;

            // Start a real SubAgentLoop in the background
            const loop = new SubAgentLoop();
            const abortController = new AbortController();

            // Enriched system prompt with workspace context and project awareness.
            // Gives sub-agents the same foundational knowledge as Claude Code's CLAUDE.md approach.
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const workspaceInfo = workspaceFolders?.[0]
                ? `Workspace: ${workspaceFolders[0].name} at ${workspaceFolders[0].uri.fsPath}`
                : 'No workspace open.';

            const systemPrompt = [
                'You are a specialized sub-agent working within a larger coding assistant.',
                '',
                workspaceInfo,
                '',
                '## Rules',
                '- You have your own independent context window — do not worry about the parent conversation.',
                '- Be concise in tool outputs; focus on findings relevant to your task.',
                '- When done, return a clear summary of what you found or accomplished.',
                '- If you receive additional instructions from the parent mid-flight, incorporate them.',
                '- You have a limited number of turns. To find/count/list which files exist',
                '  (e.g. "how many files", "what\'s in this directory"), use one glob_files/list_dir/',
                '  search_files call, not read_file per file. To get a file\'s SIZE or LINE COUNT',
                '  specifically, use stat_path (it reports lineCount) — NOT read_file, which returns',
                '  the full file content into your own context and turn budget for no reason if all',
                '  you need is a number. When you need this for MANY files (e.g. summing line counts',
                '  across a directory), call stat_path ONCE with paths: [array of all the paths] —',
                '  not once per file. Only use read_file when you actually need the content itself.',
                '',
                `## Your Task\n${prompt}`,
                '',
                `## Available Tools\n${toolAllowlist.join(', ') || 'None'}`,
            ].join('\n');

            const agentPromise = loop.run({
                systemPrompt,
                userMessage: prompt,
                toolAllowlist,
                modelConfig: this._modelConfig,
                maxTurns,
                timeoutMs,
                onProgress: (event) => {
                    // Update agent record based on progress events
                    const currentAgent = agentManager.getAgent(agent.id);
                    if (currentAgent) {
                        currentAgent.lastActivity = Date.now();
                        if (event.type === 'tool_result') {
                            currentAgent.toolUsageCount++;
                        }
                        if (event.type === 'completed') {
                            // Only a genuinely-running agent can transition to
                            // 'completed'. Never overwrite a terminal 'stopped'/
                            // 'error' status — doing so previously made a stopped
                            // agent look successful to wait_for_agent.
                            if (currentAgent.status === 'running' || currentAgent.status === 'paused') {
                                currentAgent.status = 'completed';
                            }
                            if (event.output) {
                                currentAgent.messages.push(event.output);
                            }
                        }
                        if (event.type === 'error') {
                            // If the agent was explicitly stopped, treat it as 'stopped' not 'error'
                            if (currentAgent.status === 'stopped') {
                                // Stream a 'stopped' event to webview instead of error
                                if (this._webview) {
                                    this._webview.postMessage({
                                        command: 'agentProgress',
                                        agentId: agent.id,
                                        chatId,
                                        type: 'stopped',
                                    });
                                }
                                return;
                            }
                            currentAgent.status = 'error';
                            currentAgent.error = event.error;
                        }
                        // Track partial output for non-blocking wait_for_agent
                        if (event.type === 'partial_output' && event.output) {
                            currentAgent._partialOutput = event.output;
                        }
                    }

                    // Stream progress to webview for visibility, tagged with the
                    // owning chatId so a chat switch can't make this agent's
                    // progress render into a different conversation (P5-T5).
                    if (this._webview) {
                        this._webview.postMessage({
                            command: 'agentProgress',
                            agentId: agent.id,
                            chatId,
                            ...event,
                        });
                    }
                },
                abortSignal: abortController.signal,
                // Wire pending messages so send_agent_message actually delivers
                onDrainMessages: () => agentManager.drainPendingMessages(agent.id),
                // P6-T14: route this agent's tool calls through the parent's own
                // guardrails (risk classification, approval, audit, checkpoint)
                // instead of a separate, ungoverned dispatch path. agent.id and
                // agent.toolAllowlist (C-2 defense-in-depth) are bound here so
                // SubAgentLoop's callback stays a simple (name, args) => result
                // shape.
                executeTool: this._executeTool
                    ? (name: string, args: Record<string, unknown>) => this._executeTool!(agent.id, name, args, toolAllowlist)
                    : undefined,
            });

            // Notify webview that agent was spawned
            if (this._webview) {
                this._webview.postMessage({
                    command: 'agentSpawn',
                    agentId: agent.id,
                    chatId,
                    prompt: agent.prompt.slice(0, 200),
                    toolAllowlist: agent.toolAllowlist,
                });
            }

            // Store the promise and abort controller on the agent record.
            // Derive the FINAL status from the loop's own result (authoritative),
            // not by assuming completion — a resolved-but-unsuccessful result
            // means the agent was aborted or errored, and must not read as
            // 'completed'. Only transition an agent that's still non-terminal.
            agent._loopPromise = agentPromise.then((loopResult) => {
                const a = agentManager.getAgent(agent.id);
                if (a && (a.status === 'running' || a.status === 'paused')) {
                    if (loopResult.success) {
                        a.status = 'completed';
                    } else if (loopResult.error === 'Aborted by parent') {
                        a.status = 'stopped';
                    } else {
                        a.status = 'error';
                        a.error = loopResult.error;
                    }
                    if (loopResult.output) a.messages.push(loopResult.output);
                }
                return loopResult;
            }).catch((err) => {
                const a = agentManager.getAgent(agent.id);
                if (a && (a.status === 'running' || a.status === 'paused')) {
                    a.status = 'error';
                    a.error = String(err);
                }
                throw err;
            });

            agent._abortController = abortController;

            return {
                success: true,
                output: JSON.stringify({
                    ...agentSummary(result),
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `send_agent_message` tool.
 * Queues a message for a running subagent.
 */
export class SendAgentMessageExecutor implements ToolExecutor {
    public name = 'send_agent_message';

    private _chatId: string | undefined;

    setChatId(chatId: string | undefined): void {
        this._chatId = chatId;
    }

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const agentId = String(args.agentId || '');
            const message = String(args.message || '');

            if (!agentId) {
                return { success: false, output: '', error: 'Missing required parameter: agentId' };
            }

            if (!message) {
                return { success: false, output: '', error: 'Missing required parameter: message' };
            }

            // P5-T5: an agent belonging to a different chat is treated as not
            // found — a tool call from one conversation must not be able to
            // message another conversation's agent.
            if (!agentManager.getOwnedAgent(agentId, this._chatId)) {
                return { success: false, output: '', error: `AGENT_NOT_FOUND: '${agentId}'` };
            }

            const sent = agentManager.sendMessage(agentId, message);
            if (!sent) {
                const agent = agentManager.getOwnedAgent(agentId, this._chatId);
                if (!agent) {
                    return { success: false, output: '', error: `AGENT_NOT_FOUND: '${agentId}'` };
                }
                return { success: false, output: '', error: `AGENT_TERMINAL: agent '${agentId}' is in '${agent.status}' state and cannot receive messages` };
            }

            return { success: true, output: JSON.stringify({ agentId, queued: true, messageCount: agentManager.getOwnedAgent(agentId, this._chatId)?.messages.length }, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `get_agent_status` tool.
 * Returns the current status, progress, and tool usage statistics of a subagent.
 */
export class GetAgentStatusExecutor implements ToolExecutor {
    public name = 'get_agent_status';

    private _chatId: string | undefined;

    setChatId(chatId: string | undefined): void {
        this._chatId = chatId;
    }

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const agentId = String(args.agentId || '');

            if (!agentId) {
                return { success: false, output: '', error: 'Missing required parameter: agentId' };
            }

            const agent = agentManager.getOwnedAgent(agentId, this._chatId);
            if (!agent) {
                return { success: false, output: '', error: `AGENT_NOT_FOUND: '${agentId}'` };
            }

            return { success: true, output: JSON.stringify(agentSummary(agent), null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `wait_for_agent` tool.
 * Waits for an agent's SubAgentLoop to complete (via _loopPromise) or falls back
 * to polling for backward compatibility with agents spawned without a loop.
 */
export class WaitForAgentExecutor implements ToolExecutor {
    public name = 'wait_for_agent';

    private _chatId: string | undefined;

    setChatId(chatId: string | undefined): void {
        this._chatId = chatId;
    }

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const agentId = String(args.agentId || '');
            const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : 600000;

            if (!agentId) {
                return { success: false, output: '', error: 'Missing required parameter: agentId' };
            }

            // P5-T5: ownership-gated lookup — once this passes, the agentId is
            // confirmed to belong to this chat, so subsequent internal refreshes
            // below can use the plain (unscoped) getAgent().
            const agent = agentManager.getOwnedAgent(agentId, this._chatId);
            if (!agent) {
                return { success: false, output: '', error: `AGENT_NOT_FOUND: '${agentId}'` };
            }

            // If agent already in terminal state, return immediately with an
            // unambiguous signal — a stopped/errored agent is a failure, and its
            // partial output must not be presented as a finished result.
            if (agent.status === 'completed') {
                return {
                    success: true,
                    output: JSON.stringify({ ...agentSummary(agent), waited: false }, null, 2),
                };
            }
            if (agent.status === 'stopped') {
                return {
                    success: false,
                    output: JSON.stringify({ ...agentSummary(agent), waited: false, cancelled: true }, null, 2),
                    error: `CANCELLED: agent '${agentId}' was stopped before it finished. Its output is PARTIAL — do not treat it as the agent's result.`,
                };
            }
            if (agent.status === 'error') {
                return {
                    success: false,
                    output: JSON.stringify({ ...agentSummary(agent), waited: false }, null, 2),
                    error: `AGENT_FAILED: ${agent.error || 'the agent errored before completing'}. Any output is partial — do not treat it as a finished result.`,
                };
            }

            // Prefer awaiting the loop promise directly over polling
            if (agent._loopPromise) {
                try {
                    const result = await Promise.race([
                        agent._loopPromise,
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs),
                        ),
                    ]);
                    const currentAgent = agentManager.getAgent(agentId);
                    const status = currentAgent?.status ?? 'completed';
                    const partial = typeof result === 'object' && result !== null && 'output' in result
                        ? String((result as any).output)
                        : String(result);

                    // A stopped/errored agent must NOT read as success. Return an
                    // explicit, unambiguous result so the parent model doesn't
                    // treat partial output as the agent's finished answer.
                    if (status === 'stopped') {
                        return {
                            success: false,
                            output: JSON.stringify({
                                ...(currentAgent ? agentSummary(currentAgent) : { id: agentId, status: 'stopped' }),
                                waited: true,
                                cancelled: true,
                                partialOutput: partial,
                            }, null, 2),
                            error: `CANCELLED: agent '${agentId}' was stopped before it finished. The text above is PARTIAL and incomplete — do not treat it as the agent's result. Re-run the work yourself or spawn a new agent if you still need it.`,
                        };
                    }
                    if (status === 'error') {
                        return {
                            success: false,
                            output: JSON.stringify({
                                ...(currentAgent ? agentSummary(currentAgent) : { id: agentId, status: 'error' }),
                                waited: true,
                                partialOutput: partial,
                            }, null, 2),
                            error: `AGENT_FAILED: ${currentAgent?.error || 'the agent errored before completing'}. Any text above is partial — do not treat it as a finished result.`,
                        };
                    }

                    return {
                        success: true,
                        output: JSON.stringify({
                            ...(currentAgent ? agentSummary(currentAgent) : { id: agentId, status: 'completed' }),
                            waited: true,
                            loopOutput: partial,
                        }, null, 2),
                    };
                } catch (err) {
                    const errorMsg = (err as Error).message;
                    const currentAgent = agentManager.getAgent(agentId);
                    const status = currentAgent?.status;

                    if (errorMsg === 'TIMEOUT') {
                        // Return partial output so the parent doesn't lose progress.
                        return {
                            success: false,
                            output: JSON.stringify({
                                ...(currentAgent ? agentSummary(currentAgent) : { id: agentId }),
                                waited: true,
                                timedOut: true,
                                partialOutput: currentAgent?._partialOutput || '',
                            }, null, 2),
                            error: `TIMEOUT: agent '${agentId}' did not complete within ${timeoutMs}ms — it is still running. See partialOutput for progress. Call wait_for_agent again to continue waiting.`,
                        };
                    }

                    // Agent was stopped/cancelled by user
                    if (status === 'stopped') {
                        return {
                            success: false,
                            output: JSON.stringify({
                                ...(currentAgent ? agentSummary(currentAgent) : { id: agentId, status: 'stopped' }),
                                waited: true,
                                cancelled: true,
                                partialOutput: currentAgent?._partialOutput || '',
                            }, null, 2),
                            error: `CANCELLED: agent '${agentId}' was stopped by user`,
                        };
                    }

                    // Agent errored
                    if (status === 'error') {
                        return {
                            success: false,
                            output: JSON.stringify({
                                ...(currentAgent ? agentSummary(currentAgent) : { id: agentId, status: 'error' }),
                                waited: true,
                                partialOutput: currentAgent?._partialOutput || '',
                            }, null, 2),
                            error: currentAgent?.error || errorMsg,
                        };
                    }

                    return { success: false, output: '', error: `Loop error: ${errorMsg}` };
                }
            }

            // Fall back to polling for backward compatibility
            const pollResult = await agentManager.waitForAgent(agentId, timeoutMs);

            if (pollResult === 'timeout') {
                const currentAgent = agentManager.getAgent(agentId);
                return {
                    success: false,
                    output: JSON.stringify({
                        ...(currentAgent ? agentSummary(currentAgent) : { id: agentId }),
                        waited: true,
                        timedOut: true,
                        partialOutput: currentAgent?._partialOutput || '',
                    }, null, 2),
                    error: `TIMEOUT: agent '${agentId}' did not complete within ${timeoutMs}ms — still running.`,
                };
            }

            return {
                success: pollResult.status === 'completed',
                output: JSON.stringify({
                    ...agentSummary(pollResult),
                    waited: true,
                }, null, 2),
                error: pollResult.status === 'error' ? pollResult.error : undefined,
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `stop_agent` tool.
 * Aborts the agent's SubAgentLoop (if running) and sets its status to 'stopped'.
 */
export class StopAgentExecutor implements ToolExecutor {
    public name = 'stop_agent';

    private _chatId: string | undefined;

    setChatId(chatId: string | undefined): void {
        this._chatId = chatId;
    }

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const agentId = String(args.agentId || '');

            if (!agentId) {
                return { success: false, output: '', error: 'Missing required parameter: agentId' };
            }

            // P5-T5: a chat can only stop its own agents.
            const agent = agentManager.getOwnedAgent(agentId, this._chatId);
            if (!agent) {
                return { success: false, output: '', error: `AGENT_NOT_FOUND: '${agentId}'` };
            }

            // Abort the running sub-agent loop if one exists
            if (agent._abortController) {
                agent._abortController.abort();
            }

            agent.status = 'stopped';
            agent.lastActivity = Date.now();

            return { success: true, output: JSON.stringify({ agentId, status: 'stopped', stopped: true }, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
