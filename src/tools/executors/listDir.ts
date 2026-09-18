import * as fs from 'fs';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot } from '../pathSafety';

export class ListDirExecutor implements ToolExecutor {
    public name = 'list_dir';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const relPath = String(args.path || '.');
            const workspaceRoot = getWorkspaceRoot();
            const target = resolveWorkspacePath(relPath, workspaceRoot);

            if (!fs.existsSync(target)) {
                return { success: false, output: '', error: `PATH_NOT_FOUND: ${relPath}` };
            }

            const stat = fs.statSync(target);
            if (!stat.isDirectory()) {
                return { success: false, output: '', error: `Not a directory: ${relPath}` };
            }

            const entries = fs.readdirSync(target, { withFileTypes: true })
                .map(entry => ({ name: entry.name, is_directory: entry.isDirectory() }));

            return { success: true, output: JSON.stringify(entries, null, 2) };
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('PATH_TRAVERSAL') || err.message.includes('SYMLINK_ESCAPE') || err.message.includes('escapes workspace')) {
                return { success: false, output: '', error: err.message };
            }
            return { success: false, output: '', error: err.message };
        }
    }
}
