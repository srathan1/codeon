import { ToolDefinition } from './toolDefinitions';
import { toolRegistry } from './toolRegistry';
import { featureFlags } from './toolDefinitions';
import { ContextManager } from '../context/contextManager';

/** Groups that tools can belong to. */
export type ToolGroup = 'core' | 'git' | 'process' | 'codeintel' | 'build' | 'checkpoint' | 'task' | 'env' | 'web' | 'debug' | 'multiagent' | 'mcp' | 'skill' | 'memory';

/**
 * Keyword → group mapping.
 * When a user message contains any of these keywords (case-insensitive),
 * the corresponding tool group is added to the request.
 *
 * Note: "browser" group removed (P0-T2) — browser tools purged until P3-T3 Playwright implementation.
 */
const KEYWORD_GROUPS: Record<string, readonly string[]> = {
    // Git operations
    git: ['git', 'commit', 'push', 'pull', 'branch', 'merge', 'rebase', 'stash', 'reset', 'checkout', 'diff', 'log', 'blame', 'stage', 'unstage', 'restore', 'conflict'],
    process: ['process', 'daemon', 'server', 'background', 'port', 'listen', 'stdout', 'stderr', 'pipe', 'spawn', 'kill'],
    codeintel: ['definition', 'reference', 'symbol', 'refactor', 'rename', 'hover', 'diagnostic', 'lint', 'format', 'quick fix', 'code action', 'lsp'],
    build: ['build', 'compile', 'test', 'coverage', 'npm', 'yarn', 'cargo', 'maven', 'gradle', 'make', 'profile'],
    checkpoint: ['checkpoint', 'snapshot', 'backup', 'restore', 'save point'],
    task: ['task', 'todo', 'note', 'notification', 'remind'],
    env: ['environment', 'env', 'secret', 'credential', 'runtime', 'variable'],
    web: ['search', 'fetch', 'url', 'http', 'https', 'web', 'download', 'page', 'website', 'link', 'online'],
    debug: ['debug', 'breakpoint', 'call stack', 'debugger', 'step over', 'step into', 'watch'],
    multiagent: ['subagent', 'delegate', 'fork', 'parallel agent'],
    mcp: ['mcp', 'server resource', 'invoke mcp'],
    skill: ['skill', 'load skill'],
    memory: ['memory', 'remember', 'forget', 'recall'],
};

/**
 * Get the set of groups triggered by keywords in a user message.
 */
export function getTriggeredGroups(message: string): Set<ToolGroup> {
    const lower = message.toLowerCase();
    const groups = new Set<ToolGroup>();

    for (const [group, keywords] of Object.entries(KEYWORD_GROUPS)) {
        if (keywords.some(kw => lower.includes(kw))) {
            groups.add(group as ToolGroup);
        }
    }

    return groups;
}

/** Multi-agent tool names gated behind the multiAgentEnabled feature flag. */
const multiAgentTools = new Set([
    'spawn_agent', 'send_agent_message', 'get_agent_status',
    'wait_for_agent', 'stop_agent',
]);

/** MCP tool names gated behind the mcpEnabled feature flag. */
const mcpGatedTools = new Set([
    'list_mcp_resources', 'read_mcp_resource', 'invoke_mcp_tool',
]);

/**
 * Select tools to send to the LLM.
 *
 * Strategy (P1-T4): Send ALL non-gated tool definitions and rely on
 * `tool_choice: "auto"` for the model to pick the right tool.
 * This eliminates fragile keyword-based substring matching that caused
 * false positives (e.g., "fix the search function" triggering web tools).
 *
 * ~37 working tools × ~300 tokens ≈ ~11K tokens for tool definitions,
 * which is acceptable for models with 128K+ context windows.
 */
export function selectTools(_userMessage?: string): ToolDefinition[] {
    const allDefs = toolRegistry.allDefinitions();
    return allDefs.filter(def => {
        if (multiAgentTools.has(def.name) && !featureFlags.multiAgentEnabled) return false;
        if (mcpGatedTools.has(def.name) && !featureFlags.mcpEnabled) return false;
        return true;
    });
}

/**
 * Estimate the approximate token cost of sending tool definitions to the model.
 * Serializes each definition's name, description, and parameters schema to JSON,
 * then counts tokens using the cl100k_base encoder.
 */
export function estimateToolDefinitionTokens(definitions: ToolDefinition[]): number {
    let total = 0;
    for (const def of definitions) {
        const repr = JSON.stringify({
            name: def.name,
            description: def.description,
            parameters: def.parameters,
        });
        total += ContextManager.countTokens(repr);
    }
    return total;
}
