import { ToolExecutor, ExecutorResult } from '../toolExecutor';
import { terminalManager } from '../terminalManager';

const MAX_COMMAND_LENGTH = 10000;

/** Execute a shell command in a persistent VS Code terminal named "CodeOn". */
export class ExecuteInTerminalExecutor implements ToolExecutor {
    public name = 'execute_in_terminal';

    public async execute(args: Record<string, unknown>): Promise<ExecutorResult> {
        const command = String(args.command ?? '');
        const reveal = args.reveal !== false;
        const waitForExit = Boolean(args.waitForExit);

        if (!command.trim()) {
            return { success: false, output: '', error: 'COMMAND_EMPTY: No command provided' };
        }

        if (command.length > MAX_COMMAND_LENGTH) {
            return {
                success: false,
                output: '',
                error: `COMMAND_TOO_LONG: Command exceeds ${MAX_COMMAND_LENGTH} characters`,
            };
        }

        terminalManager.sendCommand(command, reveal as boolean);

        if (waitForExit) {
            return {
                success: true,
                output: 'Command sent to CodeOn terminal. The terminal does not support waiting for exit; check the terminal panel for output.',
            };
        }

        return {
            success: true,
            output: 'Command sent to CodeOn terminal',
        };
    }
}
