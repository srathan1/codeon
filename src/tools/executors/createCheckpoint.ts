import * as fs from 'fs';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot, resolveWorkspacePath } from '../pathSafety';
import { checkpointManager } from '../checkpointManager';

/**
 * createCheckpoint tool (Phase 4, R0).
 * Creates a recoverable snapshot of specified files by storing their current content
 * in .codeon/checkpoints/.
 */
export class CreateCheckpointExecutor implements ToolExecutor {
    public name = 'create_checkpoint';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const label = args.label ? String(args.label) : `checkpoint_${Date.now()}`;
            const rawPaths = args.paths;

            let paths: string[];
            if (typeof rawPaths === 'string' && rawPaths.length > 0) {
                try {
                    paths = JSON.parse(rawPaths);
                } catch {
                    return { success: false, output: '', error: 'INVALID_PATHS: paths must be a valid JSON array string' };
                }
            } else if (Array.isArray(rawPaths)) {
                paths = rawPaths.map(String);
            } else {
                return { success: false, output: '', error: 'MISSING_PATHS: paths array is required and must not be empty' };
            }

            if (!paths || paths.length === 0) {
                return { success: false, output: '', error: 'MISSING_PATHS: paths array is required and must not be empty' };
            }

            // Trim whitespace from each path
            paths = paths.map((p: unknown) => String(p).trim()).filter(Boolean);

            const workspaceRoot = getWorkspaceRoot();
            const files: Array<{ path: string; hash: string }> = [];

            for (const relPath of paths) {
                const absPath = resolveWorkspacePath(relPath, workspaceRoot);

                if (!fs.existsSync(absPath)) {
                    return { success: false, output: '', error: `FILE_NOT_FOUND: ${relPath}` };
                }

                if (!fs.statSync(absPath).isFile()) {
                    return { success: false, output: '', error: `NOT_A_FILE: ${relPath} is not a regular file` };
                }

                // Compute hash of current content
                const content = fs.readFileSync(absPath, 'utf8');
                const hash = require('crypto').createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);

                files.push({ path: relPath, hash });
            }

            const checkpoint = checkpointManager.create(label, files);

            const output = {
                action: 'create_checkpoint',
                checkpoint: {
                    id: checkpoint.id,
                    label: checkpoint.label,
                    createdAt: new Date(checkpoint.createdAt).toISOString(),
                    files: Object.keys(checkpoint.files),
                    fileCount: Object.keys(checkpoint.files).length,
                    storageMethod: checkpoint.storageMethod,
                },
            };

            return { success: true, output: JSON.stringify(output, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
