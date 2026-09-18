import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot } from '../pathSafety';
import { runShellCommand } from '../shellRunner';

export class RunTestsExecutor implements ToolExecutor {
    public name = 'run_tests';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const fileFilter = args.file ? String(args.file) : undefined;
            const nameFilter = args.name ? String(args.name) : undefined;
            const coverage = args.coverage === true;
            const timeoutSec = Math.max(10, Math.min(Number(args.timeout || 120), 600));

            const root = getWorkspaceRoot();
            const rootFiles = fs.existsSync(root) ? fs.readdirSync(root) : [];

            let command: string;
            let testFramework: string = 'unknown';

            if (rootFiles.includes('package.json')) {
                const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                const pm = rootFiles.includes('pnpm-lock.yaml') ? 'pnpm' : rootFiles.includes('yarn.lock') ? 'yarn' : 'npm';

                if (deps.jest || deps['ts-jest']) {
                    testFramework = 'jest';
                    command = `npx jest${coverage ? ' --coverage' : ''}`;
                } else if (deps.mocha) {
                    testFramework = 'mocha';
                    command = `npx mocha${coverage ? ' --require c8' : ''}`;
                } else if (deps.vitest) {
                    testFramework = 'vitest';
                    command = `npx vitest run${coverage ? ' --coverage' : ''}`;
                } else if (pkg.scripts?.test) {
                    command = `${pm} run test`;
                } else {
                    return { success: false, output: '', error: 'No test framework detected.' };
                }
            } else if (rootFiles.includes('Cargo.toml')) {
                testFramework = 'cargo-test';
                command = 'cargo test';
            } else if (rootFiles.includes('go.mod')) {
                testFramework = 'go-test';
                command = 'go test ./...';
            } else if (rootFiles.includes('pyproject.toml') || rootFiles.includes('requirements.txt')) {
                testFramework = 'pytest';
                command = 'pytest';
            } else if (rootFiles.includes('pom.xml')) {
                testFramework = 'maven-surefire';
                command = 'mvn test';
            } else if (rootFiles.some(f => f.endsWith('.csproj'))) {
                testFramework = 'dotnet-test';
                command = 'dotnet test';
            } else {
                return { success: false, output: '', error: 'No test framework detected.' };
            }

            // Apply filters
            if (fileFilter) command += ` ${fileFilter}`;
            if (nameFilter && testFramework === 'jest') command += ` -t "${nameFilter}"`;
            if (nameFilter && testFramework === 'pytest') command += ` -k "${nameFilter}"`;
            if (nameFilter && testFramework === 'mocha') command += ` --grep "${nameFilter}"`;

            return this.runTestCommand(command, testFramework, timeoutSec);
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }

    private async runTestCommand(command: string, testFramework: string, timeoutSec: number): Promise<ToolResult> {
        const result = await runShellCommand(command, timeoutSec, getWorkspaceRoot());
        const combinedOutput = result.output + (result.error || '');

        // Parse test results
        const passed = (combinedOutput.match(/✓/g) || []).length + (combinedOutput.match(/\bpassed\b/gi) || []).length;
        const failed = (combinedOutput.match(/✗/g) || []).length + (combinedOutput.match(/\bfailed\b/gi) || []).length;
        const skipped = (combinedOutput.match(/skip/i) || []).length;

        // Extract failure details
        const failures: Array<{ message: string }> = [];
        const failureRegex = /(?:(FAIL|Failed|✗)\s*[\s\S]*?)(?=(FAIL|Failed|✗|$))/gi;
        for (const m of combinedOutput.match(failureRegex) || []) {
            const lines = m.split('\n').slice(0, 10);
            failures.push({ message: lines.join('\n').trim() });
            if (failures.length >= 10) break;
        }

        return {
            success: result.success,
            output: JSON.stringify({
                framework: testFramework,
                command,
                exitCode: result.success ? 0 : -1,
                summary: {
                    passed: Math.max(passed, 0),
                    failed: Math.max(failed, 0),
                    skipped,
                },
                failures: failures.slice(0, 10),
            }, null, 2) + (failed > 0 ? '\n\n' + combinedOutput : ''),
            error: result.error || undefined,
        };
    }
}
