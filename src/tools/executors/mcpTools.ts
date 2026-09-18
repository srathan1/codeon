import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { toolRegistry } from '../toolRegistry';

/**
 * Singleton manager for MCP server connections.
 *
 * TODO: Implement actual MCP transport layer (stdio/HTTP) in a future release.
 * Currently provides the client shell that returns "not configured" messages when no servers are available.
 */
class McpClientManager {
    /**
     * Get the list of configured MCP server names from VS Code settings.
     * Servers are expected to be configured under `codeon.mcpServers`.
     */
    public getConfiguredServers(): string[] {
        const config = vscode.workspace.getConfiguration('codeon');
        // Try the mcpServers key; if not present, return empty
        const servers = config.get<Record<string, unknown>>('mcpServers', {});
        return Object.keys(servers);
    }

    /**
     * Check if a specific MCP server is configured.
     */
    public isServerConfigured(serverName: string): boolean {
        return this.getConfiguredServers().includes(serverName);
    }

    /**
     * Get advertised resources for a configured server.
     *
     * TODO: Replace with actual MCP resource listing once transport is implemented.
     */
    public getResources(_serverName: string): Array<{ uri: string; name: string; description?: string }> {
        // Placeholder — will be populated when MCP transport is implemented
        return [];
    }

    /**
     * Read a resource by URI from an MCP server.
     *
     * TODO: Replace with actual MCP resource read once transport is implemented.
     */
    public async readResource(_serverName: string, _uri: string): Promise<string | null> {
        return null;
    }

    /**
     * Invoke a tool on an MCP server.
     *
     * TODO: Replace with actual MCP tool invocation once transport is implemented.
     */
    public async invokeTool(_serverName: string, _toolName: string, _arguments: Record<string, unknown>): Promise<unknown> {
        return null;
    }
}

/** Global singleton — shared across all MCP-related executors. */
const mcpClientManager = new McpClientManager();

/**
 * Executor for the `search_tools` tool.
 * Searches registered tool definitions by keyword matching against name and description.
 */
export class SearchToolsExecutor implements ToolExecutor {
    public name = 'search_tools';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const query = String(args.query || '').toLowerCase().trim();

            if (!query) {
                return { success: false, output: '', error: 'Missing required parameter: query' };
            }

            const definitions = toolRegistry.allDefinitions();
            const terms = query.split(/\s+/).filter(t => t.length > 0);

            interface MatchedTool {
                name: string;
                description: string;
                phase: number;
                riskLevel: string;
                relevance: number;
            }

            const matches: MatchedTool[] = [];

            for (const def of definitions) {
                let score = 0;
                const nameLower = def.name.toLowerCase();
                const descLower = def.description.toLowerCase();

                for (const term of terms) {
                    // Exact name match gets highest weight
                    if (nameLower === term) score += 100;
                    // Name contains term
                    else if (nameLower.includes(term)) score += 50;
                    // Description contains term
                    if (descLower.includes(term)) score += 20;
                }

                if (score > 0) {
                    matches.push({
                        name: def.name,
                        description: def.description,
                        phase: def.phase,
                        riskLevel: def.riskLevel,
                        relevance: score,
                    });
                }
            }

            // Sort by relevance descending
            matches.sort((a, b) => b.relevance - a.relevance);

            return {
                success: true,
                output: JSON.stringify({ query, count: matches.length, tools: matches }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `load_tool` tool.
 * Looks up a tool definition in the registry by name.
 * This is READ-ONLY — it does not dynamically register new tools.
 */
export class LoadToolExecutor implements ToolExecutor {
    public name = 'load_tool';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const toolName = String(args.toolName || '');

            if (!toolName) {
                return { success: false, output: '', error: 'Missing required parameter: toolName' };
            }

            const def = toolRegistry.getDefinition(toolName);
            if (!def) {
                return { success: false, output: '', error: `TOOL_NOT_FOUND: '${toolName}' is not registered in the tool catalog` };
            }

            return {
                success: true,
                output: JSON.stringify({
                    name: def.name,
                    description: def.description,
                    riskLevel: def.riskLevel,
                    riskClass: def.riskClass,
                    phase: def.phase,
                    parameters: def.parameters,
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `list_mcp_resources` tool.
 * Returns a list of MCP servers and their advertised resources.
 * If no servers are configured, returns a helpful message explaining how to configure them.
 */
export class ListMcpResourcesExecutor implements ToolExecutor {
    public name = 'list_mcp_resources';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const serverName = args.serverName ? String(args.serverName) : undefined;

            const configuredServers = mcpClientManager.getConfiguredServers();

            if (configuredServers.length === 0) {
                return {
                    success: true,
                    output: JSON.stringify({
                        servers: [],
                        message: 'No MCP servers are configured. Configure servers in VS Code settings under "codeon.mcpServers".\n\nNote: MCP transport layer (stdio/HTTP) is planned for a future release.',
                    }, null, 2),
                };
            }

            if (serverName && !mcpClientManager.isServerConfigured(serverName)) {
                return {
                    success: false,
                    output: '',
                    error: `MCP_SERVER_NOT_CONFIGURED: '${serverName}' is not configured. Available servers: ${configuredServers.join(', ')}`,
                };
            }

            const serversToCheck = serverName ? [serverName] : configuredServers;
            const result: Record<string, Array<{ uri: string; name: string; description?: string }>> = {};

            for (const srv of serversToCheck) {
                result[srv] = mcpClientManager.getResources(srv);
            }

            return {
                success: true,
                output: JSON.stringify({
                    servers: configuredServers,
                    resources: result,
                    note: 'MCP resource listing is a placeholder. Actual resource discovery will be available once the MCP transport layer is implemented.',
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `read_mcp_resource` tool.
 * Reads a resource from an MCP server by URI.
 */
export class ReadMcpResourceExecutor implements ToolExecutor {
    public name = 'read_mcp_resource';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const serverName = String(args.serverName || '');
            const uri = String(args.uri || '');

            if (!serverName) {
                return { success: false, output: '', error: 'Missing required parameter: serverName' };
            }

            if (!uri) {
                return { success: false, output: '', error: 'Missing required parameter: uri' };
            }

            if (!mcpClientManager.isServerConfigured(serverName)) {
                return {
                    success: false,
                    output: '',
                    error: `MCP_SERVER_NOT_CONFIGURED: '${serverName}' is not configured`,
                };
            }

            const content = await mcpClientManager.readResource(serverName, uri);
            if (content === null) {
                return {
                    success: false,
                    output: '',
                    error: `RESOURCE_READ_FAILED: Unable to read '${uri}' from '${serverName}'. MCP transport layer is not yet implemented.`,
                };
            }

            return { success: true, output: content };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `invoke_mcp_tool` tool.
 * Invokes a tool on an MCP server with the given arguments.
 * Passes through policy evaluation before execution.
 */
export class InvokeMcpToolExecutor implements ToolExecutor {
    public name = 'invoke_mcp_tool';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const serverName = String(args.serverName || '');
            const toolName = String(args.toolName || '');
            const argumentsRaw = args.arguments ? String(args.arguments) : '{}';

            if (!serverName) {
                return { success: false, output: '', error: 'Missing required parameter: serverName' };
            }

            if (!toolName) {
                return { success: false, output: '', error: 'Missing required parameter: toolName' };
            }

            if (!mcpClientManager.isServerConfigured(serverName)) {
                return {
                    success: false,
                    output: '',
                    error: `MCP_SERVER_NOT_CONFIGURED: '${serverName}' is not configured`,
                };
            }

            let toolArgs: Record<string, unknown>;
            try {
                toolArgs = JSON.parse(argumentsRaw);
            } catch {
                return { success: false, output: '', error: `INVALID_ARGUMENTS: Could not parse arguments as JSON: ${argumentsRaw}` };
            }

            const result = await mcpClientManager.invokeTool(serverName, toolName, toolArgs);
            if (result === null) {
                return {
                    success: false,
                    output: '',
                    error: `TOOL_INVOCATION_FAILED: Unable to invoke '${toolName}' on '${serverName}'. MCP transport layer is not yet implemented.`,
                };
            }

            return { success: true, output: JSON.stringify(result, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
