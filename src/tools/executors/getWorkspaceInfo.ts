import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ToolExecutor, ToolResult } from '../toolExecutor';

export class GetWorkspaceInfoExecutor implements ToolExecutor {
    public name = 'get_workspace_info';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders?.length) {
                return { success: false, output: '', error: 'No workspace folder open' };
            }

            const roots = folders.map(f => f.uri.fsPath);
            const activeRoot = roots[0];

            // Trust state
            const isTrusted = vscode.workspace.isTrusted;

            // Platform info
            const platform = process.platform;
            const pathSep = path.sep;
            const caseSensitive = platform !== 'win32';

            // Repository roots
            let repositoryRoots: string[] = [];
            if (args.includeRepositoryRoots) {
                const api = vscode.extensions.getExtension('vscode.git');
                if (api) {
                    const gitApi = api.exports.getAPI(1);
                    repositoryRoots = (gitApi.repositories as Array<{ rootUri?: { fsPath: string } }>).map((r) => r.rootUri?.fsPath ?? '');
                }
            }

            // Project hints
            let projectTypes: string[] = [];
            if (args.includeProjectHints) {
                const rootFiles = fs.existsSync(activeRoot) ? fs.readdirSync(activeRoot) : [];
                if (rootFiles.includes('package.json')) {
                    try {
                        const pkg = JSON.parse(fs.readFileSync(path.join(activeRoot, 'package.json'), 'utf8'));
                        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                        if (deps.typescript || deps.react || deps['vue']) projectTypes.push('typescript');
                        if (deps.pytest || deps.flask) projectTypes.push('python');
                        if (deps['maven-plugin']) projectTypes.push('java');
                    } catch { /* ignore */ }
                }
                if (rootFiles.includes('Cargo.toml')) projectTypes.push('rust');
                if (rootFiles.includes('go.mod')) projectTypes.push('go');
                if (rootFiles.includes('CMakeLists.txt')) projectTypes.push('cpp');
                if (rootFiles.includes('build.gradle')) projectTypes.push('java');
                if (rootFiles.includes('Gemfile')) projectTypes.push('ruby');
                if (projectTypes.length === 0) projectTypes.push('unknown');
            }

            const info = {
                workspaceRoots: roots,
                activeRoot,
                trustState: isTrusted ? 'trusted' : 'untrusted',
                platform,
                pathSeparator: pathSep,
                caseSensitive,
                repositoryRoots,
                projectTypes,
            };

            return { success: true, output: JSON.stringify(info, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
