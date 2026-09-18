import { spawn } from 'child_process';

/**
 * Shared git command runner used by all git tool executors.
 * Uses `spawn` (streaming) instead of `exec` (buffered) to avoid
 * ERR_CHILD_PROCESS_STDOUT_MAXBUFFER crashes on large output.
 */

interface RunGitOptions {
    /** Maximum bytes of stdout to collect before truncating. Default 1 MB. */
    maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB

/**
 * Run a git subcommand and return stdout as a string.
 * Accepts either a space-separated string or an array of arguments.
 * Prefer the array form when arguments may contain spaces or special characters.
 *
 * @param cwd  Working directory (usually the repo root).
 * @param args Git subcommand and arguments, e.g. `'log -n 5'` or `['log', '-n', '5']`.
 */
export function runGitCommand(cwd: string, args: string | string[], options?: RunGitOptions): Promise<string> {
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    const parts = Array.isArray(args) ? args : splitArgs(args);

    return new Promise((resolve, reject) => {
        const child = spawn('git', parts, { cwd });

        const chunks: Buffer[] = [];
        let totalLen = 0;
        let truncated = false;

        child.stdout.on('data', (data: Buffer) => {
            if (!truncated && totalLen + data.length > maxBytes) {
                // Keep only what fits
                const remaining = maxBytes - totalLen;
                chunks.push(data.subarray(0, remaining));
                truncated = true;
            } else if (!truncated) {
                chunks.push(data);
                totalLen += data.length;
            }
        });

        const stderrChunks: Buffer[] = [];

        child.stderr.on('data', (data: Buffer) => {
            stderrChunks.push(data);
        });

        child.on('error', (err: Error) => {
            reject(new Error(`SPAWN_FAILED: ${err.message}`));
        });

        child.on('close', (code) => {
            const output = Buffer.concat(chunks).toString('utf8');
            if (code !== 0) {
                const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
                reject(new Error(stderr || `EXIT_CODE_${code}`));
            } else {
                resolve(truncated ? output + `\n# ... truncated (exceeded ${maxBytes} bytes limit)` : output);
            }
        });
    });
}

/**
 * Minimal argument splitter that handles quoted strings.
 * Avoids shell injection by NOT using sh -c.
 */
function splitArgs(args: string): string[] {
    const result: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < args.length; i++) {
        const ch = args[i];

        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\') {
            escaped = true;
            current += ch;
            continue;
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }

        if (ch === ' ' && !inSingle && !inDouble) {
            if (current.length > 0) {
                result.push(current);
                current = '';
            }
            continue;
        }

        current += ch;
    }

    if (current.length > 0) {
        result.push(current);
    }

    return result;
}
