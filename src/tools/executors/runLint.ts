import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot } from '../pathSafety';
import { runShellCommand } from '../shellRunner';

export class RunLintExecutor implements ToolExecutor {
    public name = 'run_lint';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const files = args.files ? String(args.files) : undefined;
            const fix = args.fix === true;
            const timeoutSec = Math.max(10, Math.min(Number(args.timeout || 60), 300));

            // Auto-detect lint command
            const root = getWorkspaceRoot();
            const fs = require('fs');
            const pathMod = require('path');
            const rootFiles = fs.existsSync(root) ? fs.readdirSync(root) : [];

            let command: string;
            if (rootFiles.includes('package.json')) {
                const pkg = JSON.parse(fs.readFileSync(pathMod.join(root, 'package.json'), 'utf8'));
                const pm = rootFiles.includes('pnpm-lock.yaml') ? 'pnpm' : rootFiles.includes('yarn.lock') ? 'yarn' : 'npm';
                command = pkg.scripts?.lint ? `${pm} run lint` : `${pm} run lint`;
                if (fix) command += ' -- --fix';
            } else if (rootFiles.includes('Cargo.toml')) {
                command = 'cargo clippy';
            } else if (rootFiles.includes('go.mod')) {
                command = 'golangci-lint run';
            } else if (rootFiles.includes('pyproject.toml') || rootFiles.includes('requirements.txt')) {
                command = 'flake8 .';
            } else {
                return { success: false, output: '', error: 'No linter detected. Specify a profile.' };
            }

            if (files) {
                command += ` ${files}`;
            }

            return this.runLintCommand(command, timeoutSec);
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }

    private async runLintCommand(command: string, timeoutSec: number): Promise<ToolResult> {
        const result = await runShellCommand(command, timeoutSec, getWorkspaceRoot());
        const combinedOutput = result.output + (result.error || '');

        const diagnostics: Array<{ file: string; line: number; severity: string; message: string }> = [];
        for (const line of combinedOutput.split('\n')) {
            const match = line.match(/([^:]+):(\d+):?\s*(.*)/);
            if (match) {
                diagnostics.push({
                    file: match[1].trim(),
                    line: parseInt(match[2], 10),
                    severity: line.toLowerCase().includes('error') ? 'error' : 'warning',
                    message: match[3].trim().slice(0, 200),
                });
            }
        }

        return {
            success: result.success,
            output: JSON.stringify({
                exitCode: result.success ? 0 : -1,
                findings: diagnostics.length,
                diagnostics: diagnostics.slice(0, 50),
            }, null, 2),
            error: result.error || undefined,
        };
    }
}
