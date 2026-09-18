import * as fs from 'fs';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { getWorkspaceRoot } from '../pathSafety';
import { checkpointManager } from '../checkpointManager';

/**
 * restoreCheckpoint tool (Phase 4, R2).
 * Restores files to their state at a given checkpoint.
 */
export class RestoreCheckpointExecutor implements ToolExecutor {
    public name = 'restore_checkpoint';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const id = args.id ? String(args.id) : undefined;
            if (!id) {
                return { success: false, output: '', error: 'MISSING_ID: checkpoint id is required' };
            }

            // Verify checkpoint exists
            const checkpoint = checkpointManager.get(id);
            if (!checkpoint) {
                return { success: false, output: '', error: `CHECKPOINT_NOT_FOUND: '${id}'` };
            }

            const dryRun = Boolean(args.dryRun);
            const workspaceRoot = getWorkspaceRoot();

            if (dryRun) {
                // Report what would be restored without making changes
                const filesToRestore: Array<{ path: string; beforeHash: string; currentHash?: string }> = [];

                for (const [relPath, fileInfo] of Object.entries(checkpoint.files)) {
                    const absPath = require('path').resolve(workspaceRoot, relPath);
                    let currentHash: string | undefined;

                    if (fs.existsSync(absPath)) {
                        try {
                            const content = fs.readFileSync(absPath, 'utf8');
                            currentHash = require('crypto').createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
                        } catch {
                            currentHash = '<unreadable>';
                        }
                    } else {
                        currentHash = '<missing>';
                    }

                    filesToRestore.push({
                        path: relPath,
                        beforeHash: fileInfo.beforeHash,
                        currentHash,
                    });
                }

                const output = {
                    action: 'restore_checkpoint',
                    checkpointId: id,
                    label: checkpoint.label,
                    dryRun: true,
                    note: 'DRY_RUN: no changes were made',
                    filesThatWouldBeRestored: filesToRestore,
                };

                return { success: true, output: JSON.stringify(output, null, 2) };
            }

            // Perform the actual restore
            await checkpointManager.restore(id);

            // Compute after-state hashes
            const restoredFiles: Array<{ path: string; beforeHash: string; afterHash: string }> = [];

            for (const [relPath, fileInfo] of Object.entries(checkpoint.files)) {
                const absPath = require('path').resolve(workspaceRoot, relPath);
                if (fs.existsSync(absPath)) {
                    try {
                        const content = fs.readFileSync(absPath, 'utf8');
                        const afterHash = require('crypto').createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
                        restoredFiles.push({
                            path: relPath,
                            beforeHash: fileInfo.beforeHash,
                            afterHash,
                        });
                    } catch {
                        restoredFiles.push({
                            path: relPath,
                            beforeHash: fileInfo.beforeHash,
                            afterHash: '<error>',
                        });
                    }
                }
            }

            const output = {
                action: 'restore_checkpoint',
                checkpointId: id,
                label: checkpoint.label,
                createdAt: new Date(checkpoint.createdAt).toISOString(),
                restoredCount: restoredFiles.length,
                files: restoredFiles,
            };

            return { success: true, output: JSON.stringify(output, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
