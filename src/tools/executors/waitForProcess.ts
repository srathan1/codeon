import { ToolExecutor, ToolResult } from '../toolExecutor';
import { processManager } from '../processManager';

/**
 * wait_for_process tool (Phase 3, R0)
 *
 * Waits for a managed process to either exit or produce output matching a regex pattern.
 * Returns immediately if the process has already exited.
 */
export class WaitForProcessExecutor implements ToolExecutor {
    public name = 'wait_for_process';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const processId = args.processId ? String(args.processId) : '';
            if (!processId) {
                return { success: false, output: '', error: 'MISSING_ARGUMENT: processId is required' };
            }

            const timeoutMs = args.timeoutMs !== undefined
                ? Math.max(100, Math.min(Number(args.timeoutMs), 120000))
                : 30000;

            // Parse optional pattern
            let pattern: RegExp | undefined;
            if (args.pattern && typeof args.pattern === 'string') {
                try {
                    pattern = new RegExp(args.pattern);
                } catch (e) {
                    return { success: false, output: '', error: `INVALID_REGEX: ${(e as Error).message}` };
                }
            }

            // Verify process exists
            const proc = processManager.get(processId);
            if (!proc) {
                return { success: false, output: '', error: `PROCESS_NOT_FOUND: no process with ID '${processId}'` };
            }

            const result = await processManager.waitFor(processId, pattern, timeoutMs);

            const output = {
                processId,
                matched: result.matched,
                timedOut: result.timedOut,
                exitCode: result.exitCode,
                pattern: pattern?.source,
                timeoutMs,
            };

            return {
                success: true,
                output: JSON.stringify(output, null, 2),
            };
        } catch (e) {
            const err = e as Error;
            return { success: false, output: '', error: `WAIT_FAILED: ${err.message}` };
        }
    }
}
