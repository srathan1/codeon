import { ToolExecutor, ToolResult } from '../toolExecutor';
import { processManager } from '../processManager';

/**
 * list_processes tool (Phase 3, R0)
 *
 * Lists all managed background processes with their current status,
 * command, start time, PID, and any detected port numbers.
 */
export class ListProcessesExecutor implements ToolExecutor {
    public name = 'list_processes';

    public async execute(_args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const processes = processManager.list();

            const result = {
                total: processes.length,
                running: processes.filter(p => p.status === 'running').length,
                stopped: processes.filter(p => p.status === 'stopped').length,
                error: processes.filter(p => p.status === 'error').length,
                processes: processes.map(p => ({
                    id: p.id,
                    name: p.name,
                    command: p.command,
                    cwd: p.cwd,
                    pid: p.pid,
                    status: p.status,
                    exitCode: p.exitCode,
                    startTime: p.startTime,
                    startTimeISO: new Date(p.startTime).toISOString(),
                    uptimeSeconds: Math.floor((Date.now() - p.startTime) / 1000),
                })),
            };

            return {
                success: true,
                output: JSON.stringify(result, null, 2),
            };
        } catch (e) {
            const err = e as Error;
            return { success: false, output: '', error: `LIST_FAILED: ${err.message}` };
        }
    }
}
