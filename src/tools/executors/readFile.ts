import * as fs from 'fs';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { resolveWorkspacePath, getWorkspaceRoot, isProtectedPath } from '../pathSafety';
import { getFileVersion } from '../fileVersion';

export class ReadFileExecutor implements ToolExecutor {
    public name = 'read_file';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const relPath = String(args.path || '');
            const startLine = args.startLine !== undefined ? Number(args.startLine) : undefined;
            const endLine = args.endLine !== undefined ? Number(args.endLine) : undefined;
            const maxBytes = args.maxBytes !== undefined ? Number(args.maxBytes) : undefined;

            const workspaceRoot = getWorkspaceRoot();
            const target = resolveWorkspacePath(relPath, workspaceRoot);

            // Check protected paths
            if (isProtectedPath(target)) {
                return { success: false, output: '', error: `PROTECTED_PATH: ${relPath} matches a protected/sensitive pattern` };
            }

            if (!fs.existsSync(target)) {
                return { success: false, output: '', error: `FILE_NOT_FOUND: ${relPath}` };
            }

            const stat = fs.statSync(target);
            if (!stat.isFile()) {
                return { success: false, output: '', error: `Not a file: ${relPath}` };
            }

            // Check binary content
            let content = fs.readFileSync(target, 'utf8');

            // Enforce maxBytes limit
            if (maxBytes !== undefined && Buffer.byteLength(content, 'utf8') > maxBytes) {
                const buf = Buffer.from(content, 'utf8').slice(0, maxBytes);
                content = buf.toString('utf8');
            }

            // Line range filtering
            if (startLine !== undefined || endLine !== undefined) {
                const lines = content.split('\n');
                const start = startLine ?? 0;
                const end = endLine ?? lines.length - 1;
                content = lines.slice(start, end + 1).join('\n');
            }

            // Get file version for later mutation checks (tracked via hashContent)
            getFileVersion(target);

            return {
                success: true,
                output: content,
                error: undefined,
            };
        } catch (e) {
            const err = e as Error;
            if (err.message.includes('PATH_TRAVERSAL') || err.message.includes('SYMLINK_ESCAPE') || err.message.includes('escapes workspace')) {
                return { success: false, output: '', error: err.message };
            }
            return { success: false, output: '', error: err.message };
        }
    }
}
