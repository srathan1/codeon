import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';

/** Maximum number of lines retained per stream buffer (ring buffer). */
const MAX_BUFFER_LINES = 500;

/**
 * Kill a process and its entire tree on Windows via `taskkill /PID <pid> /T`
 * (P5-T8). `ChildProcess.kill()` on Windows only terminates the direct child
 * (the shell wrapper), leaving grandchildren — e.g. a `node` dev server the
 * shell spawned — running and holding their ports. `/T` kills the whole tree;
 * `/F` forces it. Best-effort: swallow errors since the process may already be
 * gone. No-op if we don't have a pid.
 */
function windowsTaskkill(pid: number | undefined, force: boolean): void {
    if (!pid) return;
    try {
        const args = ['/PID', String(pid), '/T'];
        if (force) args.push('/F');
        // Detached + unref so we don't inherit its lifetime; ignore output.
        spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).on('error', () => { /* taskkill unavailable — nothing more we can do */ });
    } catch {
        // taskkill spawn failed — process may already be dead
    }
}

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

/** Ring buffer that keeps at most `capacity` lines. */
class RingBuffer {
    private lines: string[] = [];
    private capacity: number;

    constructor(capacity: number = MAX_BUFFER_LINES) {
        this.capacity = capacity;
    }

    push(line: string): void {
        this.lines.push(line);
        if (this.lines.length > this.capacity) {
            this.lines.shift();
        }
    }

    getRecent(maxLines: number): string {
        const count = Math.min(maxLines, this.lines.length);
        return this.lines.slice(this.lines.length - count).join('\n');
    }

    getAll(): string {
        return this.lines.join('\n');
    }

    clear(): void {
        this.lines = [];
    }
}

/** Internal handle wrapping a spawned child process. */
interface ProcessHandle {
    id: string;
    command: string;
    cwd: string;
    name?: string;
    status: 'running' | 'stopped' | 'error';
    exitCode: number | null;
    startTime: number;
    stdoutBuffer: RingBuffer;
    stderrBuffer: RingBuffer;
    pid: number;
    child: ChildProcess;
    stdinOpen: boolean;
    /**
     * Set by stop() before signaling the child. The 'exit' handler uses this
     * to tell "we deliberately killed this via stop_process" (signal present,
     * but expected — a successful stop) apart from "the process received a
     * signal we didn't send" (crash/external kill — a real error). Without
     * it, every signal-based exit — including a clean stop() — was reported
     * as status:'error', which is exactly backwards for the common case.
     */
    stopRequested: boolean;
}

/** Public snapshot exposed to tool callers (no internal handles). */
export interface ManagedProcess {
    id: string;
    command: string;
    cwd: string;
    name?: string;
    status: 'running' | 'stopped' | 'error';
    exitCode: number | null;
    startTime: number;
    stdoutLines: number;
    stderrLines: number;
    pid: number;
}

/** Result returned by waitFor operations. */
export interface WaitForResult {
    matched: boolean;
    timedOut: boolean;
    exitCode: number | null;
}

/** Generate a short unique process ID. */
let _counter = 0;
function generateId(): string {
    _counter++;
    return `proc_${Date.now()}_${_counter}`;
}

/** Detect common port numbers in output text. */
function detectPorts(text: string): number[] {
    const matches = text.match(/\b(?:port|listening|PORT)\s*[:=]?\s*(\d{2,5})\b/gi);
    if (!matches) return [];
    const ports = new Set<number>();
    for (const m of matches) {
        const num = parseInt(m.match(/\d+/)?.[0] ?? '0', 10);
        if (num >= 1 && num <= 65535) ports.add(num);
    }
    return [...ports];
}

/**
 * ProcessManager — manages the lifecycle of background processes spawned via child_process.spawn.
 *
 * Maintains an in-memory registry mapping process IDs to spawn handles and ring-buffered output.
 */
export class ProcessManager {
    private processes = new Map<string, ProcessHandle>();

    /**
     * Start a long-running background process.
     *
     * @param command - The command string to execute (shell: true on Windows, array split on POSIX).
     * @param cwd - Working directory for the process.
     * @param name - Optional display name for the process.
     * @returns The created ManagedProcess record.
     */
    public async start(command: string, cwd: string, name?: string): Promise<ManagedProcess> {
        const id = generateId();

        // Prefer PowerShell on Windows for correct quoting; fall back to cmd.exe.
        // On POSIX use sh -c.
        const isWindows = os.platform() === 'win32';
        let shellPath: string;
        let shellArgs: string[];

        if (isWindows) {
            const winShell = await detectWindowsShell();
            if (winShell === 'pwsh') {
                shellPath = 'pwsh';
                shellArgs = ['-NoProfile', '-Command', command];
            } else if (winShell === 'powershell') {
                shellPath = 'powershell';
                shellArgs = ['-NoProfile', '-Command', command];
            } else {
                shellPath = 'cmd.exe';
                shellArgs = ['/d', '/c', command];
            }
        } else {
            shellPath = 'sh';
            shellArgs = ['-c', command];
        }

        const child = spawn(shellPath, shellArgs, {
            cwd,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
        });

        const stdoutBuffer = new RingBuffer(MAX_BUFFER_LINES);
        const stderrBuffer = new RingBuffer(MAX_BUFFER_LINES);

        // Capture stdout line by line
        let stdoutAccumulator = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            stdoutAccumulator += chunk.toString('utf8');
            const lines = stdoutAccumulator.split(/\r?\n/);
            // Keep the last partial line in the accumulator
            stdoutAccumulator = lines.pop() ?? '';
            for (const line of lines) {
                stdoutBuffer.push(line);
            }
        });

        // Capture stderr line by line
        let stderrAccumulator = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrAccumulator += chunk.toString('utf8');
            const lines = stderrAccumulator.split(/\r?\n/);
            stderrAccumulator = lines.pop() ?? '';
            for (const line of lines) {
                stderrBuffer.push(line);
            }
        });

        const handle: ProcessHandle = {
            id,
            command,
            cwd,
            name,
            status: 'running',
            exitCode: null,
            startTime: Date.now(),
            stdoutBuffer,
            stderrBuffer,
            pid: child.pid ?? 0,
            child,
            stdinOpen: true,
            stopRequested: false,
        };

        // Handle process exit
        child.on('exit', (code, signal) => {
            handle.exitCode = code;
            handle.status = (signal && !handle.stopRequested) ? 'error' : 'stopped';
            handle.stdinOpen = false;
        });

        child.on('error', (err) => {
            handle.status = 'error';
            handle.stdinOpen = false;
            stderrBuffer.push(`PROCESS_ERROR: ${err.message}`);
        });

        this.processes.set(id, handle);

        return this.toManagedProcess(handle);
    }

    /** Get a managed process by ID. */
    get(id: string): ManagedProcess | undefined {
        const handle = this.processes.get(id);
        if (!handle) return undefined;
        return this.toManagedProcess(handle);
    }

    /** List all managed processes. */
    list(): ManagedProcess[] {
        const result: ManagedProcess[] = [];
        for (const handle of this.processes.values()) {
            result.push(this.toManagedProcess(handle));
        }
        return result;
    }

    /**
     * Write text to stdin of a running interactive process.
     *
     * @param id - Process ID.
     * @param text - Text to write (newline appended automatically).
     * @throws Error if process not found or stdin is closed.
     */
    writeInput(id: string, text: string): void {
        const handle = this.processes.get(id);
        if (!handle) {
            throw new Error(`PROCESS_NOT_FOUND: no process with ID '${id}'`);
        }
        if (handle.status !== 'running') {
            throw new Error(`PROCESS_NOT_RUNNING: process '${id}' is ${handle.status}`);
        }
        if (!handle.stdinOpen || !handle.child.stdin) {
            throw new Error(`STDIN_CLOSED: stdin is not available for process '${id}'`);
        }
        handle.child.stdin.write(text.endsWith('\n') ? text : text + '\n');
    }

    /**
     * Stop a managed process gracefully.
     * Sends SIGTERM first, then SIGKILL after the grace period if still running.
     *
     * @param id - Process ID.
     * @param gracePeriodMs - Milliseconds to wait between SIGTERM and SIGKILL (default 3000).
     * @throws Error if process not found.
     */
    async stop(id: string, gracePeriodMs: number = 3000): Promise<void> {
        const handle = this.processes.get(id);
        if (!handle) {
            throw new Error(`PROCESS_NOT_FOUND: no process with ID '${id}'`);
        }
        if (handle.status !== 'running') {
            throw new Error(`PROCESS_NOT_RUNNING: process '${id}' is already ${handle.status}`);
        }

        // Mark before signaling — the 'exit' handler checks this to report a
        // deliberate stop as status:'stopped' rather than 'error', even
        // though the process technically exits via a signal either way.
        handle.stopRequested = true;

        const isWindows = os.platform() === 'win32';

        // Close stdin first
        try {
            handle.child.stdin?.end();
        } catch {
            // stdin may already be closed
        }
        handle.stdinOpen = false;

        if (isWindows) {
            // P5-T8: Windows has no real POSIX signals — child.kill('SIGINT')
            // calls TerminateProcess on the shell wrapper only, orphaning any
            // grandchildren (e.g. a dev server the shell launched). Use taskkill
            // /T for a real process-tree kill. /F is added at the force stage.
            windowsTaskkill(handle.child.pid, false);
        } else {
            // Unix: send SIGTERM
            try {
                handle.child.kill('SIGTERM');
            } catch {
                // Process may have already exited
            }
        }

        // Wait for graceful shutdown
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                // Grace period expired — force kill
                if (handle.status === 'running') {
                    if (isWindows) {
                        // Force tree-kill (/F). On Windows the earlier taskkill
                        // without /F is the "graceful" attempt; this is the hard one.
                        windowsTaskkill(handle.child.pid, true);
                    } else {
                        try {
                            handle.child.kill('SIGKILL');
                        } catch {
                            // Already dead
                        }
                    }
                }
                resolve();
            }, gracePeriodMs);

            // If process exits before timeout, clean up
            handle.child.on('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    /**
     * Read recent output from a managed process.
     *
     * @param id - Process ID.
     * @param stream - Which stream to read ('stdout', 'stderr', or 'both').
     * @param maxLines - Maximum number of recent lines to return (default 50).
     * @returns The output text.
     * @throws Error if process not found.
     */
    readOutput(id: string, stream: 'stdout' | 'stderr' | 'both', maxLines: number = 50): string {
        const handle = this.processes.get(id);
        if (!handle) {
            throw new Error(`PROCESS_NOT_FOUND: no process with ID '${id}'`);
        }

        switch (stream) {
            case 'stdout':
                return handle.stdoutBuffer.getRecent(maxLines);
            case 'stderr':
                return handle.stderrBuffer.getRecent(maxLines);
            case 'both': {
                const stdout = handle.stdoutBuffer.getRecent(maxLines);
                const stderr = handle.stderrBuffer.getRecent(maxLines);
                const parts: string[] = [];
                if (stdout) parts.push(`--- stdout ---\n${stdout}`);
                if (stderr) parts.push(`--- stderr ---\n${stderr}`);
                return parts.join('\n\n');
            }
        }
    }

    /**
     * Wait for a process to exit or for its output to match a pattern.
     *
     * @param id - Process ID.
     * @param pattern - Optional regex pattern to match against combined output.
     * @param timeoutMs - Maximum wait time in milliseconds (default 30000).
     * @returns Result indicating whether the pattern matched, whether it timed out, and the exit code.
     * @throws Error if process not found.
     */
    async waitFor(
        id: string,
        pattern?: RegExp,
        timeoutMs: number = 30000,
    ): Promise<WaitForResult> {
        const handle = this.processes.get(id);
        if (!handle) {
            throw new Error(`PROCESS_NOT_FOUND: no process with ID '${id}'`);
        }

        // If already stopped, check existing output immediately
        if (handle.status !== 'running') {
            const matched = pattern ? this.checkPattern(handle, pattern) : false;
            return { matched, timedOut: false, exitCode: handle.exitCode };
        }

        return new Promise<WaitForResult>((resolve) => {
            const deadline = Date.now() + timeoutMs;
            let resolved = false;

            // P6-T1: declare the timer/listener handles BEFORE finish/cleanup so
            // that an immediate-match `finish()` (below) doesn't reference them in
            // their temporal dead zone. Previously these were `const`s declared
            // after `cleanup`, so a pattern that already matched on entry threw
            // `ReferenceError: Cannot access 'checkInterval' before initialization`.
            let checkInterval: ReturnType<typeof setInterval> | undefined;
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            const onExit = () => {
                if (handle.status !== 'running') {
                    const matched = pattern ? this.checkPattern(handle, pattern) : true;
                    finish(matched, false);
                }
            };

            const cleanup = () => {
                handle.child.removeListener('exit', onExit);
                if (checkInterval) clearInterval(checkInterval);
                if (timeoutHandle) clearTimeout(timeoutHandle);
            };

            const finish = (matched: boolean, timedOut: boolean) => {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve({
                        matched,
                        timedOut,
                        exitCode: handle.exitCode,
                    });
                }
            };

            // Check current output immediately (safe now — cleanup guards undefined handles).
            if (pattern && this.checkPattern(handle, pattern)) {
                finish(true, false);
                return;
            }

            // Poll for pattern match (every 200ms)
            checkInterval = setInterval(() => {
                if (Date.now() >= deadline) {
                    finish(false, true);
                    return;
                }
                if (pattern && this.checkPattern(handle, pattern)) {
                    finish(true, false);
                }
            }, 200);

            // Resolve on exit
            handle.child.once('exit', onExit);

            // Hard timeout
            timeoutHandle = setTimeout(() => {
                finish(false, true);
            }, timeoutMs);
        });
    }

    /** Check if the combined output of a process matches a pattern. */
    private checkPattern(handle: ProcessHandle, pattern: RegExp): boolean {
        const fullOutput = handle.stdoutBuffer.getAll() + '\n' + handle.stderrBuffer.getAll();
        return pattern.test(fullOutput);
    }

    /** Convert internal handle to public ManagedProcess snapshot. */
    private toManagedProcess(handle: ProcessHandle): ManagedProcess {
        const allOutput = handle.stdoutBuffer.getAll() + '\n' + handle.stderrBuffer.getAll();
        const detectedPorts = detectPorts(allOutput);

        return {
            id: handle.id,
            command: handle.command,
            cwd: handle.cwd,
            name: handle.name,
            status: handle.status,
            exitCode: handle.exitCode,
            startTime: handle.startTime,
            stdoutLines: handle.stdoutBuffer.getRecent(1).split('\n').length,
            stderrLines: handle.stderrBuffer.getRecent(1).split('\n').length,
            pid: handle.pid,
        };
    }

    /** Clean up all stopped processes from the registry (optional maintenance). */
    cleanupStopped(): number {
        let removed = 0;
        for (const [id, handle] of this.processes.entries()) {
            if (handle.status !== 'running') {
                this.processes.delete(id);
                removed++;
            }
        }
        return removed;
    }
}

/** Global singleton instance. */
export const processManager = new ProcessManager();
