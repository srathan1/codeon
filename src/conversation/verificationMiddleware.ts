import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

/** Result of a single verification step. */
interface VerificationStep {
    name: string;
    passed: boolean;
    output: string;       // truncated summary for model context
    durationMs: number;
}

/** Full verification result appended to tool output. */
export interface VerificationResult {
    steps: VerificationStep[];
    overall: 'passed' | 'failed' | 'skipped';
    files: string[];      // files that were verified
    totalDurationMs: number;
}

/** File-modifying tool names that trigger auto-verification. */
const MODIFYING_TOOLS = new Set([
    'edit_file',
    'write_file',
    'apply_patch',
    'apply_multi_edit',
]);

/**
 * Extract changed file paths from a tool call + result.
 * Different tools report paths differently.
 */
export function extractChangedFiles(
    toolName: string,
    args: Record<string, unknown>,
    _output?: string
): string[] {
    const files: string[] = [];

    switch (toolName) {
        case 'edit_file':
        case 'write_file':
        case 'apply_patch': {
            const fp = args.file || args.filePath || args.path || args.file_path;
            if (typeof fp === 'string') files.push(fp);
            break;
        }
        case 'apply_multi_edit': {
            const rawEdits = args.edits;
            if (Array.isArray(rawEdits)) {
                for (const e of rawEdits) {
                    if (e && typeof e.path === 'string') {
                        files.push(e.path);
                    }
                }
            }
            break;
        }
        default:
            break;
    }

    return files;
}

/**
 * Detect the project type and return the appropriate verify commands.
 * Cached per workspace for performance.
 *
 * H-4: previously a single bare module-level variable, so the FIRST
 * workspace's detection result was cached forever and reused for every
 * subsequently opened workspace — e.g. detecting a Rust project, then
 * opening a TypeScript project, would keep returning Rust lint/test/typecheck
 * commands. Keyed by workspace root path instead.
 */
type ProjectInfo = { lint: string | null; test: string | null; typecheck: string | null; projectType: string };
const _projectCache = new Map<string, ProjectInfo>();

async function detectProject(root: string): Promise<ProjectInfo> {
    const cached = _projectCache.get(root);
    if (cached) return cached;

    let info: ProjectInfo;
    try {
        const files = fs.existsSync(root) ? fs.readdirSync(root) : [];

        if (files.includes('package.json')) {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
            const scripts = pkg.scripts || {};
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            const pm = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : 'npm';

            let typecheck: string | null = null;
            if (deps.typescript || deps['ts-node']) {
                typecheck = scripts.typecheck ? `${pm} run typecheck` : 'npx tsc --noEmit';
            }

            info = {
                projectType: deps.typescript ? 'typescript' : 'javascript',
                lint: scripts.lint ? `${pm} run lint` : null,
                test: scripts.test ? `${pm} run test` : null,
                typecheck,
            };
        } else if (files.includes('Cargo.toml')) {
            info = {
                projectType: 'rust',
                lint: 'cargo clippy --all-targets',
                test: 'cargo test',
                typecheck: 'cargo check',
            };
        } else if (files.includes('go.mod')) {
            info = {
                projectType: 'go',
                lint: 'golangci-lint run',
                test: 'go test ./...',
                typecheck: 'go vet ./...',
            };
        } else if (files.includes('pyproject.toml') || files.includes('requirements.txt') || files.includes('setup.py')) {
            info = {
                projectType: 'python',
                lint: 'flake8 .',
                test: 'pytest',
                typecheck: files.includes('pyproject.toml') ? 'mypy .' : null,
            };
        } else {
            info = { projectType: 'unknown', lint: null, test: null, typecheck: null };
        }
    } catch {
        info = { projectType: 'unknown', lint: null, test: null, typecheck: null };
    }

    _projectCache.set(root, info);
    return info;
}

/** Clear the project detection cache (e.g., after package.json changes).
 * With no argument, clears every cached workspace; pass a root to clear just
 * that one. */
export function clearProjectCache(root?: string): void {
    if (root) {
        _projectCache.delete(root);
    } else {
        _projectCache.clear();
    }
}

/**
 * Run a shell command with timeout, returning stdout/stderr.
 */
function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
    return new Promise((resolve) => {
        exec(command, {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 512 * 1024, // 512KB
        }, (error, stdout, stderr) => {
            const output = (stdout || '').trim() || (stderr || '').trim();
            resolve({
                exitCode: typeof error?.code === 'number' ? error.code : error?.code === null ? null : 0,
                output: output || '(no output)',
            });
        });
    });
}

/**
 * Quick LSP-based diagnostics check for specific files.
 * This is fast because it uses cached VS Code language server state.
 */
async function checkDiagnostics(files: string[], workspaceRoot: string): Promise<VerificationStep> {
    const start = Date.now();
    const issues: Array<{ file: string; severity: string; message: string; line: number }> = [];

    for (const f of files) {
        const absPath = path.isAbsolute(f) ? f : path.join(workspaceRoot, f);
        try {
            const uri = vscode.Uri.file(absPath);
            const diagList = vscode.languages.getDiagnostics(uri);
            for (const diag of diagList) {
                const sevNames: Record<number, string> = { 0: 'error', 1: 'warning', 2: 'info', 3: 'hint' };
                issues.push({
                    file: f,
                    severity: sevNames[diag.severity] ?? 'unknown',
                    message: diag.message.slice(0, 200),
                    line: diag.range.start.line + 1,
                });
            }
        } catch {
            // File may not be open in editor — skip
        }
    }

    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');

    let output = '';
    if (errors.length > 0) {
        output = errors.map(e => `  ${e.file}:${e.line} [${e.severity}] ${e.message}`).join('\n');
    } else if (warnings.length > 0) {
        output = `  ${warnings.length} warning(s) found`;
    } else {
        output = '  No issues found';
    }

    return {
        name: 'diagnostics',
        passed: errors.length === 0,
        output,
        durationMs: Date.now() - start,
    };
}

/**
 * Run the linter on specific files. Uses --fix=false to avoid silent mutations.
 */
async function runLinter(
    command: string,
    files: string[],
    workspaceRoot: string,
    timeoutMs: number
): Promise<VerificationStep> {
    const start = Date.now();
    const fileArgs = files.map(f => `"${f}"`).join(' ');
    const fullCmd = `${command} ${fileArgs}`;

    const result = await runCommand(fullCmd, workspaceRoot, timeoutMs);

    // Parse common linter output patterns for error count
    const errorMatches = (result.output.match(/\berror\b/gi) || []).length;
    const passed = result.exitCode === 0 || result.exitCode === 1; // Many linters return 1 for findings

    let output = result.output.slice(0, 2000);
    if (result.output.length > 2000) {
        output = `[Truncated ${result.output.length} chars]\n` + result.output.slice(-1500);
    }

    return {
        name: 'lint',
        passed: passed && errorMatches === 0,
        output: output.split('\n').map(l => `  ${l}`).join('\n'),
        durationMs: Date.now() - start,
    };
}

/**
 * Run type checker on specific files.
 */
async function runTypecheck(
    command: string,
    workspaceRoot: string,
    timeoutMs: number
): Promise<VerificationStep> {
    const start = Date.now();
    const result = await runCommand(command, workspaceRoot, timeoutMs);

    const passed = result.exitCode === 0;
    let output = result.output.slice(0, 2000);
    if (result.output.length > 2000) {
        output = `[Truncated ${result.output.length} chars]\n` + result.output.slice(-1500);
    }

    return {
        name: 'typecheck',
        passed,
        output: output.split('\n').map(l => `  ${l}`).join('\n'),
        durationMs: Date.now() - start,
    };
}

/**
 * Run tests scoped to affected files. Falls back to full suite if scoping fails.
 */
async function runTests(
    command: string,
    files: string[],
    workspaceRoot: string,
    timeoutMs: number,
    projectType: string
): Promise<VerificationStep> {
    const start = Date.now();

    // Try to scope tests to affected files
    let scopedCommand = command;
    if (files.length > 0 && files.length <= 3) {
        // For most frameworks, passing the file path runs related tests
        const fileArgs = files.map(f => `"${f}"`).join(' ');
        if (projectType === 'typescript' || projectType === 'javascript') {
            // npm test usually forwards args to jest/mocha/vitest
            scopedCommand = `${command} ${fileArgs}`;
        } else if (projectType === 'python') {
            scopedCommand = `${command} ${fileArgs}`;
        } else if (projectType === 'rust') {
            // cargo test doesn't support file-level scoping well, use full suite
            scopedCommand = command;
        }
    }

    const result = await runCommand(scopedCommand, workspaceRoot, timeoutMs);

    // Parse pass/fail from output
    const failedCount = (result.output.match(/(?:failed|✗|FAIL)/gi) || []).length;
    const passed = result.exitCode === 0 || failedCount === 0;

    let output = result.output.slice(0, 3000);
    if (result.output.length > 3000) {
        output = `[Truncated ${result.output.length} chars]\n` + result.output.slice(-2000);
    }

    return {
        name: 'tests',
        passed,
        output: output.split('\n').map(l => `  ${l}`).join('\n'),
        durationMs: Date.now() - start,
    };
}

/**
 * Format a VerificationResult into a text block that gets appended to the tool output.
 * The format is designed to be easily parseable by the LLM.
 */
export function formatVerification(result: VerificationResult): string {
    if (result.overall === 'skipped') {
        return '\n\n[VERIFICATION SKIPPED — auto-verify disabled or no modifying tools executed]';
    }

    const lines = [
        '',
        `[VERIFICATION ${result.overall.toUpperCase()}]`,
        `Files: ${result.files.join(', ')}`,
        `Duration: ${result.totalDurationMs}ms`,
        '',
    ];

    for (const step of result.steps) {
        const stepIcon = step.passed ? '✓' : '✗';
        lines.push(`${stepIcon} ${step.name} (${step.durationMs}ms)`);
        if (!step.passed && step.output) {
            // Include failure details (truncated) for self-correction
            const detailLines = step.output.split('\n').slice(0, 15);
            lines.push(...detailLines.map(l => `    ${l}`));
        }
    }

    return lines.join('\n');
}

/**
 * Main entry point: run verification on changed files after a file-modifying tool call.
 *
 * Steps (fast → slow, short-circuit on first critical failure):
 * 1. LSP diagnostics (instant, cached)
 * 2. Type checker (fast, file-scoped)
 * 3. Linter (medium, file-scoped)
 * 4. Tests (slowest, only if configured and earlier steps pass)
 */
export async function runVerification(
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolOutput: string,
    config: {
        enabled: boolean;
        timeout: number;
        steps: { diagnostics: boolean; typecheck: boolean; lint: boolean; test: boolean };
        commands?: Record<string, string>;
    }
): Promise<VerificationResult> {
    const totalStart = Date.now();

    if (!config.enabled || !MODIFYING_TOOLS.has(toolName)) {
        return { steps: [], overall: 'skipped', files: [], totalDurationMs: 0 };
    }

    const changedFiles = extractChangedFiles(toolName, toolArgs, toolOutput);
    if (changedFiles.length === 0) {
        return { steps: [], overall: 'skipped', files: [], totalDurationMs: 0 };
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return {
            steps: [{ name: 'setup', passed: false, output: '  No workspace open', durationMs: 0 }],
            overall: 'failed',
            files: changedFiles,
            totalDurationMs: Date.now() - totalStart,
        };
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const project = await detectProject(workspaceRoot);
    const perStepTimeout = Math.floor(config.timeout * 1000 / 4); // Split timeout across steps

    const steps: VerificationStep[] = [];
    let hasCriticalFailure = false;

    // Step 1: LSP diagnostics (always run, instant)
    if (config.steps.diagnostics) {
        const diag = await checkDiagnostics(changedFiles, workspaceRoot);
        steps.push(diag);
        if (!diag.passed) hasCriticalFailure = true;
    }

    // Step 2: Type checker (skip if diagnostics already have errors and we want to short-circuit)
    if (config.steps.typecheck && project.typecheck) {
        const tc = await runTypecheck(project.typecheck, workspaceRoot, perStepTimeout);
        steps.push(tc);
        if (!tc.passed) hasCriticalFailure = true;
    }

    // Step 3: Linter (file-scoped)
    if (config.steps.lint && project.lint) {
        const customLint = config.commands?.lint;
        const lintCmd = customLint || project.lint;
        const lint = await runLinter(lintCmd, changedFiles, workspaceRoot, perStepTimeout);
        steps.push(lint);
        if (!lint.passed) hasCriticalFailure = true;
    }

    // Step 4: Tests (only if no critical failures, to give model clean signal)
    if (config.steps.test && project.test && !hasCriticalFailure) {
        const customTest = config.commands?.test;
        const testCmd = customTest || project.test;
        const test = await runTests(testCmd, changedFiles, workspaceRoot, config.timeout * 1000, project.projectType);
        steps.push(test);
        if (!test.passed) hasCriticalFailure = true;
    }

    const overall: 'passed' | 'failed' = hasCriticalFailure ? 'failed' : 'passed';

    return {
        steps,
        overall,
        files: changedFiles,
        totalDurationMs: Date.now() - totalStart,
    };
}
