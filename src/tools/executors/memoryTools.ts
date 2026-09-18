import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { containsSecrets } from '../secretRedaction';

/** A single persistent memory entry. */
interface MemoryEntry {
    key: string;
    value: string;
    scope: 'user' | 'workspace';
    createdAt: number;
    updatedAt: number;
}

/** In-memory store backed by JSON files on disk. */
class MemoryStore {
    /** Lazily resolved base directory. */
    private _baseDir: string | undefined;

    /** Get the memory storage directory, creating it if necessary. */
    private get baseDir(): string {
        if (this._baseDir) return this._baseDir;

        // Prefer workspace-relative storage under .codeon-memory/ so it travels with the project.
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            this._baseDir = path.join(folders[0].uri.fsPath, '.codeon-memory');
        } else {
            // No workspace open — use a home-directory location.
            const home = process.env.HOME || process.env.USERPROFILE || os.tmpdir();
            this._baseDir = path.join(home, '.codeon-memory');
        }

        if (!fs.existsSync(this._baseDir)) {
            fs.mkdirSync(this._baseDir, { recursive: true });
        }
        return this._baseDir;
    }

    /** Derive a deterministic filename for a given scope. */
    private filePath(scope: 'user' | 'workspace'): string {
        if (scope === 'user') {
            return path.join(this.baseDir, 'user.json');
        }

        // Workspace-scoped: hash the workspace root for isolation.
        const folders = vscode.workspace.workspaceFolders;
        let hash = 'default';
        if (folders && folders.length > 0) {
            const root = folders[0].uri.fsPath;
            hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
        }
        return path.join(this.baseDir, `${hash}.json`);
    }

    /** Load all entries for a scope from disk. */
    private load(scope: 'user' | 'workspace'): Record<string, MemoryEntry> {
        const fp = this.filePath(scope);
        if (!fs.existsSync(fp)) return {};

        try {
            const raw = fs.readFileSync(fp, 'utf-8');
            return JSON.parse(raw) as Record<string, MemoryEntry>;
        } catch {
            return {};
        }
    }

    /** Persist all entries for a scope to disk. */
    private save(scope: 'user' | 'workspace', store: Record<string, MemoryEntry>): void {
        const fp = this.filePath(scope);
        fs.writeFileSync(fp, JSON.stringify(store, null, 2), 'utf-8');
    }

    /** Read a single entry by key, or undefined. */
    public read(scope: 'user' | 'workspace', key: string): MemoryEntry | undefined {
        return this.load(scope)[key];
    }

    /** List all entries for a scope. */
    public list(scope: 'user' | 'workspace'): Record<string, MemoryEntry> {
        return this.load(scope);
    }

    /** Create or update an entry. Returns the updated entry. */
    public write(scope: 'user' | 'workspace', key: string, value: string): MemoryEntry {
        const store = this.load(scope);
        const now = Date.now();
        const existing = store[key];
        const entry: MemoryEntry = {
            key,
            value,
            scope,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        store[key] = entry;
        this.save(scope, store);
        return entry;
    }

    /** Delete an entry by key. Returns true if the entry existed. */
    public delete(scope: 'user' | 'workspace', key: string): boolean {
        const store = this.load(scope);
        if (!(key in store)) return false;
        delete store[key];
        this.save(scope, store);
        return true;
    }
}

const memoryStore = new MemoryStore();

/**
 * Executor for the `read_memory` tool.
 * Reads a persistent memory entry by key, or lists all entries when no key is provided.
 */
export class ReadMemoryExecutor implements ToolExecutor {
    public name = 'read_memory';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const scope = (args.scope as 'user' | 'workspace') || 'workspace';
            const key = args.key ? String(args.key) : undefined;

            if (key) {
                const entry = memoryStore.read(scope, key);
                if (!entry) {
                    return { success: false, output: '', error: `MEMORY_NOT_FOUND: key '${key}' not found in ${scope} scope` };
                }
                return { success: true, output: JSON.stringify(entry, null, 2) };
            }

            // List all entries
            const entries = memoryStore.list(scope);
            const keys = Object.keys(entries);
            if (keys.length === 0) {
                return { success: true, output: JSON.stringify({ scope, count: 0, entries: {} }, null, 2) };
            }

            const summary: Record<string, { value_preview: string; created_at: number; updated_at: number }> = {};
            for (const k of keys) {
                const e = entries[k];
                const preview = e.value.length > 200 ? e.value.slice(0, 200) + '…' : e.value;
                summary[k] = { value_preview: preview, created_at: e.createdAt, updated_at: e.updatedAt };
            }

            return { success: true, output: JSON.stringify({ scope, count: keys.length, entries: summary }, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `write_memory` tool.
 * Creates or updates a persistent memory entry. Rejects writes containing detected secrets.
 */
export class WriteMemoryExecutor implements ToolExecutor {
    public name = 'write_memory';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const key = String(args.key || '');
            const value = String(args.value || '');
            const scope = (args.scope as 'user' | 'workspace') || 'workspace';

            if (!key) {
                return { success: false, output: '', error: 'Missing required parameter: key' };
            }

            // Reject writes that appear to contain secrets
            if (containsSecrets(value)) {
                return { success: false, output: '', error: 'SECRET_DETECTED: Refusing to write value containing potential secrets to persistent memory' };
            }

            const entry = memoryStore.write(scope, key, value);
            return { success: true, output: JSON.stringify(entry, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}

/**
 * Executor for the `delete_memory` tool.
 * Removes a persistent memory entry by key.
 */
export class DeleteMemoryExecutor implements ToolExecutor {
    public name = 'delete_memory';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const key = String(args.key || '');
            const scope = (args.scope as 'user' | 'workspace') || 'workspace';

            if (!key) {
                return { success: false, output: '', error: 'Missing required parameter: key' };
            }

            const deleted = memoryStore.delete(scope, key);
            if (!deleted) {
                return { success: false, output: '', error: `MEMORY_NOT_FOUND: key '${key}' not found in ${scope} scope` };
            }

            return { success: true, output: JSON.stringify({ deleted: true, key, scope }, null, 2) };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
