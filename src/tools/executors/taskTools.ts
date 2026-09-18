import { ToolExecutor, ToolResult } from '../toolExecutor';
import { createTask, updateTask, listTasks, getTask, writeNote, readNote, listNotes, sendNotification, Task } from '../taskState';

export class CreateTaskExecutor implements ToolExecutor {
    public name = 'create_task';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const title = String(args.title || '');
            const description = String(args.description || '');
            const agentId = args.agentId ? String(args.agentId) : undefined;
            const fileScope = args.fileScope ? (Array.isArray(args.fileScope) ? args.fileScope as string[] : [String(args.fileScope)]) : undefined;

            if (!title) return { success: false, output: '', error: 'Missing required parameter: title' };

            const task = createTask(title, description, agentId, fileScope);
            return { success: true, output: JSON.stringify(task, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

export class UpdateTaskExecutor implements ToolExecutor {
    public name = 'update_task';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const id = String(args.id || '');
            const status = args.status ? String(args.status) : undefined;
            const progress = args.progress ? String(args.progress) : undefined;
            const blocker = args.blocker ? String(args.blocker) : undefined;

            const task = updateTask(id, { status: status as Task['status'], progress, blocker });
            if (!task) return { success: false, output: '', error: `Task not found: ${id}` };

            return { success: true, output: JSON.stringify(task, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

export class ListTasksExecutor implements ToolExecutor {
    public name = 'list_tasks';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const status = args.status ? String(args.status) : undefined;
            const agentId = args.agentId ? String(args.agentId) : undefined;
            const tasks = listTasks({ status, agentId });
            return { success: true, output: JSON.stringify(tasks, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

export class GetTaskExecutor implements ToolExecutor {
    public name = 'get_task';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const id = String(args.id || '');
            const task = getTask(id);
            if (!task) return { success: false, output: '', error: `Task not found: ${id}` };
            return { success: true, output: JSON.stringify(task, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

export class WriteNoteExecutor implements ToolExecutor {
    public name = 'write_note';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const key = String(args.key || '');
            const value = String(args.value || '');
            const scope = (args.scope as 'session' | 'workspace') || 'session';

            if (!key) return { success: false, output: '', error: 'Missing required parameter: key' };

            const note = writeNote(key, value, scope);
            return { success: true, output: JSON.stringify(note, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

export class ReadNoteExecutor implements ToolExecutor {
    public name = 'read_note';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const key = args.key ? String(args.key) : undefined;

            if (key) {
                const note = readNote(key);
                if (!note) return { success: false, output: '', error: `Note not found: ${key}` };
                return { success: true, output: JSON.stringify(note, null, 2) };
            }

            // List all notes
            const scope = args.scope as 'session' | 'workspace' | undefined;
            const notes = listNotes(scope);
            return { success: true, output: JSON.stringify(notes, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

export class SendNotificationExecutor implements ToolExecutor {
    public name = 'send_notification';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const title = String(args.title || 'Notification');
            const message = String(args.message || '');
            const severity = (args.severity as 'info' | 'warning' | 'error') || 'info';

            sendNotification(title, message, severity);
            return { success: true, output: JSON.stringify({ delivered: true, title, severity }, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
