import { ToolExecutor, ToolResult } from '../toolExecutor';
import { processManager } from '../processManager';

/**
 * write_process_input tool (Phase 3, R2)
 *
 * Sends text to stdin of an interactive managed process.
 * A newline is appended automatically if not present.
 */
export class WriteProcessInputExecutor implements ToolExecutor {
    public name = 'write_process_input';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const processId = args.processId ? String(args.processId) : '';
            if (!processId) {
                return { success: false, output: '', error: 'MISSING_ARGUMENT: processId is required' };
            }

            const text = args.text ? String(args.text) : '';
            if (!text) {
                return { success: false, output: '', error: 'MISSING_ARGUMENT: text is required' };
            }

            // Verify process exists and is running
            const proc = processManager.get(processId);
            if (!proc) {
                return { success: false, output: '', error: `PROCESS_NOT_FOUND: no process with ID '${processId}'` };
            }
            if (proc.status !== 'running') {
                return { success: false, output: '', error: `PROCESS_NOT_RUNNING: process '${processId}' is ${proc.status}` };
            }

            processManager.writeInput(processId, text);

            const result = {
                success: true,
                processId,
                bytesWritten: Buffer.byteLength(text.endsWith('\n') ? text : text + '\n', 'utf8'),
            };

            return {
                success: true,
                output: JSON.stringify(result, null, 2),
            };
        } catch (e) {
            const err = e as Error;
            return { success: false, output: '', error: `WRITE_FAILED: ${err.message}` };
        }
    }
}
