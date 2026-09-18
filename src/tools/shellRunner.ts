import { spawn, SpawnOptions } from 'child_process';
import * as os from 'os';

/** Cached shell detection result. */
let cachedShell: string | null = null;
let cachedShellArgs: ((cmd: string) => string[]) | null = null;

/**
 * Detect the best available Windows shell, preferring pwsh > powershell > cmd.exe.
 * Result is cached after the first call.
 */
async function detectWindowsShell(): Promise<{ shell: string; makeArgs: (cmd: string) => string[] }> {
    if (cachedShell && cachedShellArgs) {
        return { shell: cachedShell, makeArgs: cachedShellArgs };
    }

    const check = (name: string): Promise<boolean> =>
        new Promise(resolve => {
            const p = spawn(name, ['-NoProfile', '-Version']);
            p.on('close', code => resolve(code === 0));
            p.on('error', () => resolve(false));
            setTimeout(() => resolve(false), 3000);
        });

    if (await check('pwsh')) {
        cachedShell = 'pwsh';
        cachedShellArgs = cmd => ['-NoProfile', '-Command', cmd];
    } else if (await check('powershell')) {
        cachedShell = 'powershell';
        cachedShellArgs = cmd => ['-NoProfile', '-Command', cmd];
    } else {
        cachedShell = 'cmd.exe';
        cachedShellArgs = cmd => ['/d', '/c', cmd];
    }

    return { shell: cachedShell, makeArgs: cachedShellArgs };
}

/**
 * Run a shell command with cross-platform shell detection.
 * Falls back through pwsh → powershell → cmd.exe on Windows.
 */
export function runShellCommand(command: string, timeoutSec: number, cwd: string): Promise<{ success: boolean; output: string; error?: string }> {
    const isWindows = os.platform() === 'win32';

    return new Promise(async resolve => {
        let shell: string;
        let shellArgs: string[];

        if (isWindows) {
            const detected = await detectWindowsShell();
            shell = detected.shell;
            shellArgs = detected.makeArgs(command);
        } else {
            shell = '/bin/sh';
            shellArgs = ['-c', command];
        }

        const options: SpawnOptions = {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        };

        let stdout = '';
        let stderr = '';

        try {
            const child = spawn(shell, shellArgs, options);

            child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
            child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

            child.on('error', (err: Error) => {
                resolve({
                    success: false,
                    output: '',
                    error: `SPAWN_FAILED: ${err.message}. Tried: ${shell}`,
                });
            });

            child.on('close', (code: number | null) => {
                if (code === 0) {
                    resolve({ success: true, output: stdout.trim(), error: stderr.trim() || undefined });
                } else {
                    resolve({
                        success: false,
                        output: stdout.trim(),
                        error: stderr.trim() || `Exit code ${code}`,
                    });
                }
            });

            // Kill on timeout
            setTimeout(() => {
                try {
                    if (isWindows) {
                        child.kill('SIGINT');
                    } else {
                        child.kill('SIGTERM');
                    }
                    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 2000);
                } catch { /* already dead */ }
                resolve({ success: false, output: stdout, error: `TIMEOUT: timed out after ${timeoutSec}s` });
            }, timeoutSec * 1000);
        } catch (error) {
            resolve({
                success: false,
                output: '',
                error: `SPAWN_ERROR: ${(error as Error).message}`,
            });
        }
    });
}
