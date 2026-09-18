import { ToolExecutor, ToolResult } from '../toolExecutor';
import { checkpointManager } from '../checkpointManager';

/**
 * listCheckpoints tool (Phase 4, R0).
 * Lists all available checkpoints with metadata.
 */
export class ListCheckpointsExecutor implements ToolExecutor {
    public name = 'list_checkpoints';

    public async execute(_args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const checkpoints = checkpointManager.list();

            const output = {
                total: checkpoints.length,
                checkpoints: checkpoints.map(cp => ({
                    id: cp.id,
                    label: cp.label,
                    createdAt: new Date(cp.createdAt).toISOString(),
                    fileCount: Object.keys(cp.files).length,
                    files: Object.keys(cp.files),
                    storageMethod: cp.storageMethod,
                })),
            };

            return { success: true, output: JSON.stringify(output, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
