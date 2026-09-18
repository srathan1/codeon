import { ToolDefinition } from './toolDefinitions';
import { ToolExecutor } from './toolExecutor';

/**
 * Central registry for tools.
 * Provides O(1) lookup by name and tracks which tools are parallel-safe.
 */
export class ToolRegistry {
    private definitions = new Map<string, ToolDefinition>();
    private executors = new Map<string, ToolExecutor>();

    /** Register a tool definition and its executor. */
    public register(def: ToolDefinition, executor: ToolExecutor): void {
        this.definitions.set(def.name, def);
        this.executors.set(def.name, executor);
    }

    /** Get a tool definition by name. */
    public getDefinition(name: string): ToolDefinition | undefined {
        return this.definitions.get(name);
    }

    /** Get a tool executor by name. */
    public getExecutor(name: string): ToolExecutor | undefined {
        return this.executors.get(name);
    }

    /** Check if a tool is parallel-safe (read-only, no side effects). */
    public isParallelSafe(name: string): boolean {
        // L-7: riskClass is the authoritative field; riskLevel is the legacy
        // 3-tier label kept only for display. Checking both meant a tool
        // definition with matching riskClass:'R0' but a stale/omitted
        // riskLevel would be silently treated as unsafe to parallelize.
        const def = this.definitions.get(name);
        return def?.riskClass === 'R0';
    }

    /** All tool definitions (for LLM function calling schema). */
    public allDefinitions(): ToolDefinition[] {
        return [...this.definitions.values()];
    }

    /** Get only Phase 1+2 tool definitions (default exposed catalog). */
    public getDefaultCatalog(): ToolDefinition[] {
        return [...this.definitions.values()].filter(d => d.phase <= 2);
    }

    /** Check if a tool is registered. */
    public has(name: string): boolean {
        return this.definitions.has(name);
    }

    /**
     * Create a new ToolRegistry containing only the specified tools.
     * Agent-management and user-interaction tools are always excluded from subsets
     * (sub-agents never get agent management or user interaction tools).
     */
    public createSubset(allowedNames: string[]): ToolRegistry {
        const subset = new ToolRegistry();
        const excluded = new Set([
            'spawn_agent',
            'send_agent_message',
            'get_agent_status',
            'wait_for_agent',
            'stop_agent',
            'ask_user_question',
        ]);
        for (const name of allowedNames) {
            if (excluded.has(name)) continue;
            const def = this.getDefinition(name);
            const exec = this.getExecutor(name);
            if (def && exec) {
                subset.register(def, exec);
            }
        }
        return subset;
    }
}

/** Global singleton — populated at startup by toolDefinitions.ts. */
export const toolRegistry = new ToolRegistry();
