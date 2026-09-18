/** Result returned by tool executors. */
export interface ExecutorResult {
    success: boolean;
    output: string;
    error?: string;
}

/** Backward-compatible alias for executor files that still reference the old name. */
export type ToolResult = ExecutorResult;

/**
 * Contract for tool implementations.
 * Each tool implements this interface and registers itself with the ToolRegistry.
 */
export interface ToolExecutor {
    /** Human-readable tool name (matches the name in ToolDefinition). */
    name: string;

    /** Execute the tool with the given arguments. */
    execute(args: Record<string, unknown>): Promise<ExecutorResult>;
}
