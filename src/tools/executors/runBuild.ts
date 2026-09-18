import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot } from '../pathSafety';
import { runShellCommand } from '../shellRunner';

export class RunBuildExecutor implements ToolExecutor {
    public name = 'run_build';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const profile = args.profile ? String(args.profile) : undefined;
            const timeoutSec = Math.max(10, Math.min(Number(args.timeout || 120), 600));

            // Determine build command from profile or auto-detect
            let command: string;
            if (profile) {
                command = profile;
            } else {
                // Auto-detect
                const root = getWorkspaceRoot();
                const fs = require('fs');
                const path = require('path');
                const files = fs.existsSync(root) ? fs.readdirSync(root) : [];

                if (files.includes('package.json')) {
                    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
                    const pm = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : 'npm';
                    command = pkg.scripts?.build ? `${pm} run build` : `${pm} run build`;
                } else if (files.includes('Cargo.toml')) {
                    command = 'cargo build';
                } else if (files.includes('go.mod')) {
                    command = 'go build ./...';
                } else if (files.includes('pom.xml')) {
                    command = 'mvn compile';
                } else if (files.includes('build.gradle') || files.includes('build.gradle.kts')) {
                    command = './gradlew build';
                } else if (files.some((f: string) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
                    command = 'dotnet build';
                } else if (files.includes('CMakeLists.txt')) {
                    command = 'cmake --build .';
                } else {
                    return { success: false, output: '', error: 'No build system detected. Specify a profile.' };
                }
            }

            return this.runBuildCommand(command, timeoutSec);
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }

    private async runBuildCommand(command: string, timeoutSec: number): Promise<ToolResult> {
        const result = await runShellCommand(command, timeoutSec, getWorkspaceRoot());

        if (result.success) {
            return {
                success: true,
                output: JSON.stringify({ exitCode: 0, summary: 'Build succeeded' }, null, 2) + '\n\n' + result.output,
            };
        } else {
            const diagnostics: Array<{ severity: string; message: string }> = [];
            for (const line of ((result.error || '') + '\n' + result.output).split('\n')) {
                if (line.includes('error') || line.includes('Error') || line.includes('failed')) {
                    diagnostics.push({ severity: 'error', message: line.trim().slice(0, 200) });
                }
            }
            return {
                success: false,
                output: JSON.stringify({ exitCode: -1, diagnostics: diagnostics.slice(0, 20) }, null, 2) + '\n\n' + (result.error || ''),
                error: result.error || 'Build failed',
            };
        }
    }
}
