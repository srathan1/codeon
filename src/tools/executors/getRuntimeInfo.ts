import { spawn } from 'child_process';
import * as fs from 'fs';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot } from '../pathSafety';

export class GetRuntimeInfoExecutor implements ToolExecutor {
    public name = 'get_runtime_info';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const categories = args.categories ? String(args.categories).split(',') : [];

            const info: Record<string, unknown> = {
                os: process.platform,
                arch: process.arch,
                nodeVersion: process.version,
                shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
                workspaceRoot: getWorkspaceRoot(),
            };

            // Runtime versions (async)
            const versions = await this.getRuntimeVersions();
            if (!categories.length || categories.includes('runtimes')) {
                info.runtimes = versions;
            }

            // Available language servers
            if (!categories.length || categories.includes('languageservers')) {
                const vscode = require('vscode');
                const exts = vscode.extensions.all as Array<{ packageJSON: Record<string, Record<string, unknown>>; id: string }>;
                const extensions = exts.filter((e) =>
                    e.packageJSON?.contributes?.languageServers ||
                    e.packageJSON?.engines?.['node-api']
                );
                info.languageServers = extensions.map((e) => e.id);
            }

            // Project profiles
            if (!categories.length || categories.includes('profiles')) {
                const rootFiles = fs.existsSync(getWorkspaceRoot()) ? fs.readdirSync(getWorkspaceRoot()) : [];
                const projectTypes: string[] = [];
                if (rootFiles.includes('package.json')) projectTypes.push('node');
                if (rootFiles.includes('Cargo.toml')) projectTypes.push('rust');
                if (rootFiles.includes('go.mod')) projectTypes.push('go');
                if (rootFiles.includes('pom.xml')) projectTypes.push('java-maven');
                info.projectTypes = projectTypes;
            }

            return { success: true, output: JSON.stringify(info, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }

    private async getRuntimeVersions(): Promise<Record<string, string>> {
        const versions: Record<string, string> = {};
        const runners = ['node', 'npm', 'python3', 'python', 'cargo', 'go', 'java', 'dotnet', 'rustc', 'gcc', 'git'];

        for (const cmd of runners) {
            try {
                const result = await this.spawnPromise(cmd, ['--version'], 5000);
                versions[cmd] = result.trim().split('\n')[0];
            } catch {
                // Not installed
            }
        }

        return versions;
    }

    /**
     * Spawn a command with array arguments and capture stdout.
     * Avoids shell entirely — no quoting issues on any platform.
     */
    private spawnPromise(cmd: string, args: string[], timeout: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, args);
            let stdout = '';
            let stderr = '';

            child.stdout?.on('data', d => { stdout += d.toString(); });
            child.stderr?.on('data', d => { stderr += d.toString(); });

            child.on('error', err => reject(err));
            child.on('close', code => {
                if (code === 0) resolve(stdout);
                else reject(new Error(stderr || `exit code ${code}`));
            });

            setTimeout(() => {
                try { child.kill('SIGTERM'); } catch { /* already dead */ }
                reject(new Error(`timeout after ${timeout}ms`));
            }, timeout);
        });
    }
}
