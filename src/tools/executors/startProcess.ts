import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot } from '../pathSafety';
import { processManager } from '../processManager';

/**
 * start_process tool (Phase 3, R2)
 *
 * Starts a long-running background process using child_process.spawn.
 * The process is tracked in the global process registry and can be
 * interacted with via other Phase 3 tools (read_output, write_input, stop, wait).
 */
export class StartProcessExecutor implements ToolExecutor {
    public name = 'start_process';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const command = String(args.command || '').trim();
            if (!command) {
                return { success: false, output: '', error: 'MISSING_ARGUMENT: command is required' };
            }

            // Resolve cwd — default to workspace root
            let cwd: string;
            const cwdArg = args.cwd;
            if (cwdArg && typeof cwdArg === 'string') {
                const workspaceRoot = getWorkspaceRoot();
                cwd = require('path').resolve(workspaceRoot, cwdArg);
            } else {
                cwd = getWorkspaceRoot();
            }

            const name = args.name ? String(args.name) : undefined;

            const process = await processManager.start(command, cwd, name);

            const result = {
                success: true,
                id: process.id,
                pid: process.pid,
                command: process.command,
                cwd: process.cwd,
                name: process.name,
                status: process.status,
                startTime: process.startTime,
            };

            return {
                success: true,
                output: JSON.stringify(result, null, 2),
            };
        } catch (e) {
            const err = e as Error;
            return { success: false, output: '', error: `START_FAILED: ${err.message}` };
        }
    }
}
