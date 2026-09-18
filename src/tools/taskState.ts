import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * Task state and scratchpad management (PRD §13.7).
 */

export interface Task {
    id: string;
    title: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    progress?: string;
    blocker?: string;
    createdAt: number;
    updatedAt: number;
    agentId?: string;
    fileScope?: string[];
}

export interface Note {
    key: string;
    value: string;
    scope: 'session' | 'workspace';
    version: number;
    createdAt: number;
    updatedAt: number;
}

const tasks = new Map<string, Task>();
const notes = new Map<string, Note>();

let _outputChannel: vscode.OutputChannel | null = null;

function getOutputChannel(): vscode.OutputChannel {
    if (!_outputChannel) {
        _outputChannel = vscode.window.createOutputChannel('Task State');
    }
    return _outputChannel;
}

export function createTask(title: string, description: string, agentId?: string, fileScope?: string[]): Task {
    const task: Task = {
        id: 'task_' + crypto.randomBytes(6).toString('hex'),
        title,
        description,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agentId,
        fileScope,
    };
    tasks.set(task.id, task);
    return task;
}

export function updateTask(id: string, updates: Partial<Pick<Task, 'status' | 'progress' | 'blocker'>>): Task | undefined {
    const task = tasks.get(id);
    if (!task) return undefined;
    Object.assign(task, updates, { updatedAt: Date.now() });
    return task;
}

export function listTasks(filter?: { status?: string; agentId?: string }): Task[] {
    let all = Array.from(tasks.values());
    if (filter?.status) all = all.filter(t => t.status === filter.status);
    if (filter?.agentId) all = all.filter(t => t.agentId === filter.agentId);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getTask(id: string): Task | undefined {
    return tasks.get(id);
}

export function writeNote(key: string, value: string, scope: 'session' | 'workspace' = 'session'): Note {
    const existing = notes.get(key);
    const note: Note = {
        key,
        value,
        scope,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
    };
    notes.set(key, note);
    return note;
}

export function readNote(key: string): Note | undefined {
    return notes.get(key);
}

export function listNotes(scope?: 'session' | 'workspace'): Note[] {
    let all = Array.from(notes.values());
    if (scope) all = all.filter(n => n.scope === scope);
    return all;
}

export function sendNotification(title: string, message: string, severity: 'info' | 'warning' | 'error' = 'info'): void {
    const showMethod = severity === 'error' ? vscode.window.showErrorMessage :
        severity === 'warning' ? vscode.window.showWarningMessage :
            vscode.window.showInformationMessage;
    showMethod(`${title}: ${message}`);
    getOutputChannel().appendLine(`[${severity.toUpperCase()}] ${title}: ${message}`);
}

