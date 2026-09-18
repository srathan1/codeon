import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot } from '../pathSafety';

/** Detected project profile with build/lint/test commands. */
interface ProjectProfile {
    projectType: string;
    packageManager: string;
    build: string;
    lint: string;
    test: string;
    format: string;
    run: string;
    configSources: string[];
    confidence: number;
}

export class GetProjectProfileExecutor implements ToolExecutor {
    public name = 'get_project_profile';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const workspaceRoot = getWorkspaceRoot();
            const refresh = args.refresh === true;

            // Check for common project files
            const files = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot) : [];

            const profiles: ProjectProfile[] = [];

            // Node.js / TypeScript
            if (files.includes('package.json')) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'));
                    const scripts = pkg.scripts || {};
                    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

                    let projectType = 'javascript';
                    if (deps.typescript || deps['@types/node']) projectType = 'typescript';
                    if (deps.react || deps['next']) projectType = 'react';
                    if (deps.vue) projectType = 'vue';
                    if (deps.express) projectType = 'node-express';

                    let packageManager = 'npm';
                    if (files.includes('yarn.lock')) packageManager = 'yarn';
                    if (files.includes('pnpm-lock.yaml')) packageManager = 'pnpm';
                    if (files.includes('bun.lockb')) packageManager = 'bun';

                    const prefix = packageManager === 'npm' ? 'npm run' : packageManager;

                    profiles.push({
                        projectType,
                        packageManager,
                        build: scripts.build ? `${prefix} build` : `${prefix} run build`,
                        lint: scripts.lint ? `${prefix} lint` : `${prefix} run lint`,
                        test: scripts.test ? `${prefix} test` : `${prefix} run test`,
                        format: scripts.format ? `${prefix} format` : 'npx prettier --write .',
                        run: scripts.start ? `${prefix} start` : `${prefix} run start`,
                        configSources: ['package.json'],
                        confidence: 0.9,
                    });
                } catch { /* ignore */ }
            }

            // Python
            if (files.includes('requirements.txt') || files.includes('pyproject.toml') || files.includes('setup.py')) {
                profiles.push({
                    projectType: 'python',
                    packageManager: files.includes('poetry.lock') ? 'poetry' : files.includes('pipfile') ? 'pipenv' : 'pip',
                    build: 'python setup.py build',
                    lint: 'flake8 . || pylint .',
                    test: 'pytest',
                    format: 'black .',
                    run: 'python main.py',
                    configSources: [files.includes('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt'],
                    confidence: 0.7,
                });
            }

            // Rust
            if (files.includes('Cargo.toml')) {
                profiles.push({
                    projectType: 'rust',
                    packageManager: 'cargo',
                    build: 'cargo build',
                    lint: 'cargo clippy',
                    test: 'cargo test',
                    format: 'cargo fmt',
                    run: 'cargo run',
                    configSources: ['Cargo.toml'],
                    confidence: 0.95,
                });
            }

            // Go
            if (files.includes('go.mod')) {
                profiles.push({
                    projectType: 'go',
                    packageManager: 'go',
                    build: 'go build ./...',
                    lint: 'golangci-lint run',
                    test: 'go test ./...',
                    format: 'go fmt ./...',
                    run: 'go run .',
                    configSources: ['go.mod'],
                    confidence: 0.9,
                });
            }

            // Java / Maven
            if (files.includes('pom.xml')) {
                profiles.push({
                    projectType: 'java-maven',
                    packageManager: 'maven',
                    build: 'mvn compile',
                    lint: 'mvn checkstyle:check',
                    test: 'mvn test',
                    format: 'mvn formatter:format',
                    run: 'mvn exec:java',
                    configSources: ['pom.xml'],
                    confidence: 0.9,
                });
            }

            // Java / Gradle
            if (files.includes('build.gradle') || files.includes('build.gradle.kts')) {
                profiles.push({
                    projectType: 'java-gradle',
                    packageManager: 'gradle',
                    build: './gradlew build',
                    lint: './gradlew lint',
                    test: './gradlew test',
                    format: './gradlew spotlessApply',
                    run: './gradlew bootRun',
                    configSources: [files.includes('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle'],
                    confidence: 0.9,
                });
            }

            // C# / .NET
            const csprojFiles = files.filter(f => f.endsWith('.csproj') || f.endsWith('.sln'));
            if (csprojFiles.length > 0) {
                profiles.push({
                    projectType: 'csharp-dotnet',
                    packageManager: 'dotnet',
                    build: 'dotnet build',
                    lint: 'dotnet build',
                    test: 'dotnet test',
                    format: 'dotnet format',
                    run: 'dotnet run',
                    configSources: csprojFiles,
                    confidence: 0.9,
                });
            }

            // C/C++ with CMake
            if (files.includes('CMakeLists.txt')) {
                profiles.push({
                    projectType: 'cpp-cmake',
                    packageManager: 'cmake',
                    build: 'cmake --build .',
                    lint: 'clang-tidy',
                    test: 'ctest',
                    format: 'clang-format -i',
                    run: './bin/main',
                    configSources: ['CMakeLists.txt'],
                    confidence: 0.7,
                });
            }

            if (profiles.length === 0) {
                return {
                    success: true,
                    output: JSON.stringify({
                        projectType: 'unknown',
                        confidence: 0,
                        message: 'No recognized project configuration found.',
                    }, null, 2),
                };
            }

            return {
                success: true,
                output: JSON.stringify(profiles, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
