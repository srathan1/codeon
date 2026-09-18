import { spawn, SpawnOptions } from 'child_process';
import * as os from 'os';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot } from '../pathSafety';

const SENSITIVE_ENV_PATTERNS = [/TOKEN/i, /PASSWORD/i, /SECRET/i, /API_KEY/i, /PRIVATE.?KEY/i];

/* ------------------------------------------------------------------ */
/*  Windows shell detection (cached)                                  */
/* ------------------------------------------------------------------ */

let cachedWindowsShell: 'pwsh' | 'powershell' | 'cmd.exe' | null = null;

/**
 * Detect the best available Windows shell, preferring pwsh > powershell > cmd.exe.
 * Result is cached after the first call to avoid spawning a process on every command.
 */
async function detectWindowsShell(): Promise<'pwsh' | 'powershell' | 'cmd.exe'> {
    if (cachedWindowsShell) return cachedWindowsShell;

    const check = (name: 'pwsh' | 'powershell'): Promise<boolean> =>
        new Promise(resolve => {
            const p = spawn(name, ['-NoProfile', '-Version']);
            let stdout = '';
            p.stdout?.on('data', d => { stdout += d.toString(); });
            p.on('close', code => resolve(code === 0));
            p.on('error', () => resolve(false));
            setTimeout(() => resolve(false), 3000);
        });

    if (await check('pwsh')) {
        cachedWindowsShell = 'pwsh';
    } else if (await check('powershell')) {
        cachedWindowsShell = 'powershell';
    } else {
        cachedWindowsShell = 'cmd.exe';
    }

    return cachedWindowsShell;
}

/**
 * Blocked program names (exact match on the program name).
 * These are denied regardless of arguments.
 * Checked before shell execution to prevent obviously dangerous commands.
 * P5-T8: includes Windows destructive utilities, not just POSIX ones, so the
 * base-command guard isn't silently absent on Windows.
 */
const BLOCKED_PROGRAMS = new Set([
    // POSIX
    'mkfs', 'mkfs.ext4', 'mkfs.fat', 'mkfs.ntfs',
    'dd',
    'shutdown', 'reboot',
    'fdisk', 'cfdisk',
    // Windows
    'diskpart', 'format', 'format.com',
    'stop-computer', 'restart-computer',
]);

/**
 * Destructive command patterns denied regardless of platform (P5-T8/P5-T11).
 * Unlike BLOCKED_PROGRAMS (first-word match), these scan the whole command so
 * they catch destructive spellings that aren't the leading token — Windows
 * recursive deletes and PowerShell forms that the POSIX-only substring blocklist
 * would let through.
 */
const DESTRUCTIVE_COMMAND_PATTERNS: RegExp[] = [
    /\brd\s+\/s/i,                          // rd /s /q
    /\brmdir\s+\/s/i,                       // rmdir /s /q
    /remove-item\b[^\n]*-recurse[^\n]*-force/i, // Remove-Item -Recurse -Force
    /remove-item\b[^\n]*-force[^\n]*-recurse/i,
    /\bformat\s+[a-z]:/i,                   // format C:
    /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-fr)\s+[\/~]/i, // rm -rf / or ~ (root-ish)
    /rm\s+[^\n|]*--recursive[^\n|]*--force/i,
];

export class ExecuteCommandExecutor implements ToolExecutor {
    private commandBlocklist: string[];

    constructor(commandBlocklist: string[] = ['rm -rf', ':(){ :|:};', 'mkfs', 'dd if=']) {
        this.commandBlocklist = commandBlocklist;
    }

    public name = 'execute_command';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const command = String(args.command || '');
        const timeoutSec = Number(args.timeout || 30);
        const effectiveTimeout = Math.max(5, Math.min(timeoutSec, 300));

        if (!command.trim()) {
            return { success: false, output: '', error: 'COMMAND_EMPTY: No command provided' };
        }

        // Check legacy blocklist (substring-based, kept for backward compatibility)
        const blockedPattern = this.commandBlocklist.find(pattern =>
            command.toLowerCase().includes(pattern.toLowerCase())
        );
        if (blockedPattern) {
            return { success: false, output: '', error: `COMMAND_BLOCKED: '${command}' matches blocklist pattern '${blockedPattern}'` };
        }

        // Extract the first word (program name) for blocked program check.
        // This is a best-effort check — the shell handles pipes/redirects, but we
        // still want to catch obviously dangerous base commands.
        const firstWord = command.trim().split(/\s+/)[0]?.split(/[\/\\]/).pop()?.toLowerCase() ?? '';
        if (BLOCKED_PROGRAMS.has(firstWord)) {
            return { success: false, output: '', error: `COMMAND_BLOCKED: program '${firstWord}' is not allowed` };
        }

        // Whole-command destructive-pattern check (P5-T8/P5-T11) — catches
        // Windows/PowerShell recursive deletes and other destructive spellings
        // that aren't the leading token and that the substring blocklist misses.
        const destructiveMatch = DESTRUCTIVE_COMMAND_PATTERNS.find(p => p.test(command));
        if (destructiveMatch) {
            return { success: false, output: '', error: `COMMAND_BLOCKED: '${command}' matches a destructive-command pattern` };
        }

        // Sanitize environment — strip sensitive variable names
        const sanitizedEnv: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env as Record<string, string | undefined>)) {
            if (value !== undefined && !SENSITIVE_ENV_PATTERNS.some(pattern => pattern.test(key))) {
                sanitizedEnv[key] = value;
            }
        }

        // Detect git commit -m "..." and rewrite to git commit -F <tmpfile>
        // to avoid custom git aliases that misinterpret -m arguments as pathspecs.
        let effectiveCommand = command;
        let msgFile: string | null = null;
        const commitMRe = new RegExp('^(\\s*git\\s+commit\\s+(?:-\\w+\\s+)*)-m\\s+"(.*)"\\s*$', 's');
        const commitMMatch = command.match(commitMRe);
        if (commitMMatch) {
            const crypto = await import('crypto');
            const pathMod = await import('path');
            const fs = await import('fs');
            const osMod = await import('os');
            msgFile = pathMod.join(osMod.tmpdir(), `codeon-cmd-msg-${crypto.randomUUID()}.txt`);
            fs.writeFileSync(msgFile, commitMMatch[2], 'utf8');
            // PowerShell handles quoting correctly — no special escaping needed.
            effectiveCommand = `${commitMMatch[1]}-F "${msgFile}"`;
        }

        // Use a shell so pipes, redirections, globs, and variable expansion work.
        // Security comes from the blocklist + workspace boundary + env sanitization,
        // not from avoiding shells.
        const isWindows = os.platform() === 'win32';
        let shell: string;
        let shellArgs: string[];

        if (isWindows) {
            const winShell = await detectWindowsShell();
            if (winShell === 'pwsh') {
                shell = 'pwsh';
                shellArgs = ['-NoProfile', '-Command', effectiveCommand];
            } else if (winShell === 'powershell') {
                shell = 'powershell';
                shellArgs = ['-NoProfile', '-Command', effectiveCommand];
            } else {
                shell = 'cmd.exe';
                shellArgs = ['/d', '/c', effectiveCommand];
            }
        } else {
            shell = '/bin/sh';
            shellArgs = ['-c', effectiveCommand];
        }

        const options: SpawnOptions = {
            cwd: getWorkspaceRoot(),
            env: sanitizedEnv,
            shell: false, // We invoke the shell explicitly as the program
            windowsHide: true,
        };

        // H-12: the timeout-kill timer used to fire unconditionally after
        // effectiveTimeout seconds regardless of whether the process had
        // already exited — a fast command still left a live timer running in
        // the background for the rest of the timeout window, which then
        // called kill() on an already-exited (and potentially PID-recycled)
        // process. settle() below clears both the kill timer and the
        // force-kill timer as soon as the process actually settles (via
        // 'close' or 'error'), and the `settled` guard also protects against
        // 'error' and 'close' both firing for the same failure (documented
        // child_process behavior in some spawn-failure cases), which
        // previously could call resolve() twice.
        return new Promise(resolve => {
            let stdout = '';
            let stderr = '';
            let settled = false;
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

            const settle = (result: ToolResult) => {
                if (settled) return;
                settled = true;
                if (killTimer) clearTimeout(killTimer);
                if (forceKillTimer) clearTimeout(forceKillTimer);
                resolve(result);
            };

            try {
                const child = spawn(shell, shellArgs, options);

                child.stdout?.on('data', (data: Buffer) => {
                    stdout += data.toString();
                });

                child.stderr?.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });

                child.on('error', (error: Error) => {
                    settle({
                        success: false,
                        output: stdout,
                        error: `EXECUTION_ERROR: ${error.message}`,
                    });
                });

                child.on('close', (code, signal) => {
                    // Clean up temp commit message file if we created one
                    if (msgFile) {
                        try { require('fs').unlinkSync(msgFile); } catch { /* best effort */ }
                    }

                    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                        settle({
                            success: false,
                            output: stdout,
                            error: `TIMEOUT: Command timed out after ${effectiveTimeout} seconds`,
                        });
                    } else if (code === 0) {
                        settle({
                            success: true,
                            output: stdout.trim(),
                            error: stderr.trim() || undefined,
                        });
                    } else {
                        settle({
                            success: false,
                            output: stdout.trim(),
                            error: stderr.trim() || `Command exited with code ${code}`,
                        });
                    }
                });

                // Kill on timeout
                killTimer = setTimeout(() => {
                    try {
                        if (isWindows) {
                            // On Windows, kill the shell process tree
                            child.kill('SIGINT');
                        } else {
                            child.kill('SIGTERM');
                        }
                        // Force kill after grace period
                        forceKillTimer = setTimeout(() => {
                            try {
                                child.kill('SIGKILL');
                            } catch { /* already dead */ }
                        }, 2000);
                    } catch { /* already dead */ }
                }, effectiveTimeout * 1000);

            } catch (error) {
                settle({
                    success: false,
                    output: '',
                    error: `SPAWN_ERROR: ${(error as Error).message}`,
                });
            }
        });
    }
}
