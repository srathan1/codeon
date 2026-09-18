import { ToolExecutor, ToolResult } from '../toolExecutor';
import { processManager } from '../processManager';

/**
 * stop_process tool (Phase 3, R2)
 *
 * Stops a managed background process gracefully.
 * Sends SIGTERM (or SIGINT on Windows) first, then SIGKILL after the grace period
 * if the process has not exited on its own.
 */
export class StopProcessExecutor implements ToolExecutor {
    public name = 'stop_process';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const processId = args.processId ? String(args.processId) : '';
            if (!processId) {
                return { success: false, output: '', error: 'MISSING_ARGUMENT: processId is required' };
            }

            const gracePeriodMs = args.gracePeriodMs !== undefined
                ? Math.max(0, Math.min(Number(args.gracePeriodMs), 30000))
                : 3000;

            // Verify process exists
            const proc = processManager.get(processId);
            if (!proc) {
                return { success: false, output: '', error: `PROCESS_NOT_FOUND: no process with ID '${processId}'` };
            }
            if (proc.status !== 'running') {
                return { success: false, output: '', error: `PROCESS_NOT_RUNNING: process '${processId}' is already ${proc.status}` };
            }

            await processManager.stop(processId, gracePeriodMs);

            // Fetch updated status after stop
            const updated = processManager.get(processId);

            const result = {
                success: true,
                processId,
                finalStatus: updated?.status ?? 'unknown',
                exitCode: updated?.exitCode ?? null,
                gracePeriodMs,
            };

            return {
                success: true,
                output: JSON.stringify(result, null, 2),
            };
        } catch (e) {
            const err = e as Error;
            return { success: false, output: '', error: `STOP_FAILED: ${err.message}` };
        }
    }
}
