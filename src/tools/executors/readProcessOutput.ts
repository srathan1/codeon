import { ToolExecutor, ToolResult } from '../toolExecutor';
import { processManager } from '../processManager';

/**
 * read_process_output tool (Phase 3, R0)
 *
 * Reads recent output from a managed background process.
 * Supports reading stdout, stderr, or both streams with configurable line limits.
 */
export class ReadProcessOutputExecutor implements ToolExecutor {
    public name = 'read_process_output';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const processId = args.processId ? String(args.processId) : '';
            if (!processId) {
                return { success: false, output: '', error: 'MISSING_ARGUMENT: processId is required' };
            }

            const maxLines = args.maxLines !== undefined ? Math.max(1, Number(args.maxLines)) : 50;

            let stream: 'stdout' | 'stderr' | 'both' = 'both';
            if (args.stream) {
                const streamVal = String(args.stream).toLowerCase();
                if (streamVal === 'stdout' || streamVal === 'stderr' || streamVal === 'both') {
                    stream = streamVal;
                }
            }

            // Check process exists
            const proc = processManager.get(processId);
            if (!proc) {
                return { success: false, output: '', error: `PROCESS_NOT_FOUND: no process with ID '${processId}'` };
            }

            const output = processManager.readOutput(processId, stream, maxLines);

            const result = {
                processId,
                stream,
                maxLinesRequested: maxLines,
                processStatus: proc.status,
                output: output || '(no output)',
            };

            return {
                success: true,
                output: JSON.stringify(result, null, 2),
            };
        } catch (e) {
            const err = e as Error;
            return { success: false, output: '', error: `READ_FAILED: ${err.message}` };
        }
    }
}
