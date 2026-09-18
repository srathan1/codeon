import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ChatCompletionMessage } from '../types';

export interface StoredChat {
    id: string;
    title: string;
    mode: string;
    messages: ChatCompletionMessage[];
    createdAt: number;
    updatedAt: number;
    workspaceLabel?: string;
    /** Monotonic version counter for optimistic concurrency. */
    version?: number;
    /** Full pre-compaction history for display. Not sent to API context. */
    transcript?: ChatCompletionMessage[];
}

export interface ChatIndexEntry extends StoredChat {
    workspaceLabel: string;
}

/** Simple async mutex — serializes writes to prevent corruption. */
class AsyncMutex {
    private _queue: Array<() => void> = [];

    acquire(): Promise<void> {
        return new Promise(resolve => {
            if (this._queue.length === 0) {
                resolve();
            } else {
                this._queue.push(resolve);
            }
        });
    }

    release(): void {
        const next = this._queue.shift();
        if (next) next();
    }
}

/** Write a file atomically: write to .tmp, then rename (atomic on all platforms). */
function atomicWriteFileSync(filePath: string, data: string): void {
    const tmpPath = filePath + '.tmp.' + process.pid;
    try {
        fs.writeFileSync(tmpPath, data, 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (e) {
        // Clean up temp file on failure
        try {
            fs.unlinkSync(tmpPath);
        } catch { /* ignore */ }
        throw e;
    }
}

/** Read JSON with corruption recovery: try parsing, fall back to empty array on truncated writes. */
function safeReadJSON<T>(filePath: string, fallback: T): T {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export class ChatStore {
    private static readonly MAX_CHATS = 50;
    private _writeMutex = new AsyncMutex();
    /** Whether the one-time index→individual-file migration has run. */
    private _migrated = false;
    /** Whether readIndex()'s legacy-location fallback migration has been attempted (M-11). */
    private _legacyMigrationAttempted = false;

    constructor(
        private readonly storagePath: string,
        private readonly legacyPath?: string,
        private readonly _workspaceLabel: string = ''
    ) {
        if (!fs.existsSync(storagePath)) {
            fs.mkdirSync(storagePath, { recursive: true });
        }
    }

    /**
     * One-time migration: for every chat in chats.json that lacks an individual
     * chatId.json file, create the file from the index entry.
     * Idempotent — runs at most once per store lifetime.
     */
    private ensureMigrated(): void {
        if (this._migrated) return;
        this._migrated = true;

        const index = this.readIndex();
        let migrated = 0;
        for (const chat of index) {
            if (!fs.existsSync(this.chatFile(chat.id))) {
                this.saveChatFile(chat);
                migrated++;
            }
        }
        if (migrated > 0) {
            console.log(`[ChatStore] Migrated ${migrated} chat(s) from index to individual files`);
        }
    }

    private chatsFile(): string {
        return path.join(this.storagePath, 'chats.json');
    }

    private legacyChatsFile(): string | null {
        if (!this.legacyPath) return null;
        return path.join(this.legacyPath, 'chats.json');
    }

    private readIndex(): StoredChat[] {
        try {
            const chats = safeReadJSON<StoredChat[]>(this.chatsFile(), []);
            return chats.map((c: StoredChat) => ({ ...c, workspaceLabel: this._workspaceLabel || c.workspaceLabel }));
        } catch {
            // Fall back to legacy location and auto-migrate. M-11: this write
            // path isn't behind _writeMutex (readIndex is a synchronous
            // helper called from both inside and outside mutex-held async
            // contexts, so acquiring the mutex here risks deadlocking a
            // caller that already holds it). Guarded by _legacyMigrationAttempted
            // instead so the actual migration write only ever runs once per
            // ChatStore instance — after the first successful write,
            // this.chatsFile() exists and every later call takes the try
            // branch above, never re-entering this fallback at all.
            if (this._legacyMigrationAttempted) return [];
            this._legacyMigrationAttempted = true;

            const legacy = this.legacyChatsFile();
            if (legacy && fs.existsSync(legacy)) {
                try {
                    const chats = safeReadJSON<StoredChat[]>(legacy, []);
                    // Migrate: write to new location + individual chat files
                    this.writeIndex(chats);
                    for (const chat of chats) {
                        this.saveChatFile(chat);
                    }
                    return chats.map(c => ({ ...c, workspaceLabel: this._workspaceLabel || c.workspaceLabel }));
                } catch {
                    return [];
                }
            }
            return [];
        }
    }

    private writeIndex(chats: StoredChat[]): void {
        atomicWriteFileSync(this.chatsFile(), JSON.stringify(chats, null, 2));
    }

    private chatFile(chatId: string): string {
        return path.join(this.storagePath, `${chatId}.json`);
    }

    private saveChatFile(chat: StoredChat): void {
        atomicWriteFileSync(this.chatFile(chat.id), JSON.stringify(chat, null, 2));
    }

    listChats(): StoredChat[] {
        return this.readIndex()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, ChatStore.MAX_CHATS);
    }

    /**
     * Discover chats from all workspace-scoped directories under a global storage root.
     * Each chat is tagged with its workspace label.
     */
    public static listAllChats(globalStoragePath: string): ChatIndexEntry[] {
        const chatsDir = path.join(globalStoragePath, 'chats');
        const allChats: ChatIndexEntry[] = [];

        // 1. Read legacy/global chats (no workspace folder)
        const legacyIndex = path.join(globalStoragePath, 'chats.json');
        if (fs.existsSync(legacyIndex)) {
            try {
                const chats = safeReadJSON<StoredChat[]>(legacyIndex, []);
                allChats.push(...chats.map(c => ({ ...c, workspaceLabel: 'Global' })));
            } catch { /* ignore */ }
        }

        // 2. Scan workspace-scoped subdirectories
        if (!fs.existsSync(chatsDir)) return allChats;
        for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const wsIndex = path.join(chatsDir, entry.name, 'chats.json');
            if (!fs.existsSync(wsIndex)) continue;
            try {
                const chats = safeReadJSON<StoredChat[]>(wsIndex, []);
                const label = entry.name.replace(/_/g, ' ');
                allChats.push(...chats.map(c => ({ ...c, workspaceLabel: label })));
            } catch { /* ignore corrupt index */ }
        }

        return allChats
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, ChatStore.MAX_CHATS);
    }

    getChat(chatId: string): StoredChat | null {
        this.ensureMigrated();
        try {
            const raw = fs.readFileSync(this.chatFile(chatId), 'utf8');
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    createChat(mode: string = 'plan'): StoredChat {
        const chat: StoredChat = {
            // L-3: crypto.randomUUID() instead of Date.now() + 6 random chars
            // — the old scheme had a (small but real, and easy to eliminate)
            // collision risk under rapid creation within the same millisecond.
            id: `chat-${crypto.randomUUID()}`,
            title: 'New Chat',
            mode,
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: 1,
            workspaceLabel: this._workspaceLabel || undefined
        };
        const index = this.readIndex();
        index.unshift(chat);
        this._pruneIndex(index);
        this.writeIndex(index);
        this.saveChatFile(chat);
        return chat;
    }

    /**
     * P5-T16: actually delete chats beyond MAX_CHATS instead of only capping the
     * *listing*. Mutates `index` in place to keep the newest MAX_CHATS entries
     * (by updatedAt) and removes the individual files of the pruned ones, so
     * per-chat files don't accumulate without bound over a long-lived workspace.
     */
    private _pruneIndex(index: StoredChat[]): void {
        if (index.length <= ChatStore.MAX_CHATS) return;
        const sorted = [...index].sort((a, b) => b.updatedAt - a.updatedAt);
        const keep = new Set(sorted.slice(0, ChatStore.MAX_CHATS).map(c => c.id));
        for (const chat of index) {
            if (!keep.has(chat.id)) {
                try { fs.unlinkSync(this.chatFile(chat.id)); } catch { /* ignore */ }
            }
        }
        // Rewrite index array in place to only the kept chats.
        const kept = index.filter(c => keep.has(c.id));
        index.length = 0;
        index.push(...kept);
    }

    async saveMessages(chatId: string, messages: ChatCompletionMessage[], title?: string, transcript?: ChatCompletionMessage[]): Promise<void> {
        this.ensureMigrated();
        // Acquire write lock to serialize concurrent saves
        await this._writeMutex.acquire();
        try {
            const chat = this.getChat(chatId);
            if (!chat) {
                console.warn(`[ChatStore] saveMessages: chat '${chatId}' not found — dropping ${messages.length} messages`);
                return;
            }
            chat.messages = messages;
            if (transcript !== undefined) {
                chat.transcript = transcript;
            }
            chat.updatedAt = Date.now();
            chat.version = (chat.version || 0) + 1;
            if (title) chat.title = title;
            this.saveChatFile(chat);

            // Update index position to top — strip transcript from index entry
            // to keep chats.json lightweight (transcript lives in individual files only).
            const index = this.readIndex();
            const idx = index.findIndex(c => c.id === chatId);
            const indexEntry: StoredChat = { ...chat, transcript: undefined };
            if (idx >= 0) {
                index.splice(idx, 1);
                index.unshift(indexEntry);
            } else {
                index.unshift(indexEntry);
            }
            this.writeIndex(index);
        } finally {
            this._writeMutex.release();
        }
    }

    /** H-9: mutex-protected like saveMessages — deleteChat does its own
     * read-modify-write of the index (readIndex → filter → writeIndex), and
     * without the same lock a concurrent saveMessages() could interleave
     * with it and corrupt the index or resurrect a chat that was just
     * deleted. */
    async deleteChat(chatId: string): Promise<void> {
        await this._writeMutex.acquire();
        try {
            // Delete from current workspace-scoped storage
            try {
                fs.unlinkSync(this.chatFile(chatId));
            } catch { /* ignore */ }
            const index = this.readIndex().filter(c => c.id !== chatId);
            this.writeIndex(index);

            // Also remove from global legacy chats.json (if it exists there)
            this._deleteFromGlobalLegacy(chatId);

            // Also remove from all workspace-scoped subdirectories under global storage root
            this._deleteFromAllWorkspaceDirs(chatId);
        } finally {
            this._writeMutex.release();
        }
    }

    /** Remove a chat from the global legacy chats.json at <globalRoot>/chats.json. */
    private _deleteFromGlobalLegacy(chatId: string): void {
        const legacyIndex = path.join(path.dirname(this.storagePath), '..', 'chats.json');
        if (!fs.existsSync(legacyIndex)) return;
        try {
            const chats = safeReadJSON<StoredChat[]>(legacyIndex, []);
            const filtered = chats.filter(c => c.id !== chatId);
            if (filtered.length !== chats.length) {
                atomicWriteFileSync(legacyIndex, JSON.stringify(filtered, null, 2));
                // Also remove individual chat file if it exists at legacy level
                try { fs.unlinkSync(path.join(path.dirname(this.storagePath), '..', `${chatId}.json`)); } catch { /* ignore */ }
            }
        } catch { /* ignore corrupt file */ }
    }

    /** Remove a chat from all workspace-scoped subdirectories under chats/.
     * Bug found while fixing H-9 (confirmed pre-existing — fails identically
     * without any of this pass's changes): this used the same
     * `path.dirname(this.storagePath) + '..'` pattern as
     * _deleteFromGlobalLegacy, which is correct THERE (it wants the global
     * root, two levels up from `.../chats/workspace1`) but wrong here — this
     * function wants `.../chats` itself (the directory *containing* the
     * workspace subdirectories, one level up), so the extra '..' overshot by
     * one level and silently scanned the wrong directory, never finding any
     * workspace subdirectories to clean up. */
    private _deleteFromAllWorkspaceDirs(chatId: string): void {
        const chatsDir = path.dirname(this.storagePath);
        if (!fs.existsSync(chatsDir) || !fs.statSync(chatsDir).isDirectory()) return;
        try {
            for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const wsIndex = path.join(chatsDir, entry.name, 'chats.json');
                if (!fs.existsSync(wsIndex)) continue;
                try {
                    const chats = safeReadJSON<StoredChat[]>(wsIndex, []);
                    const filtered = chats.filter(c => c.id !== chatId);
                    if (filtered.length !== chats.length) {
                        atomicWriteFileSync(wsIndex, JSON.stringify(filtered, null, 2));
                        try { fs.unlinkSync(path.join(chatsDir, entry.name, `${chatId}.json`)); } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    /** Same read-modify-write shape as deleteChat/saveMessages — mutex-protected
     * for the same reason (H-9). */
    async updateTitle(chatId: string, title: string): Promise<void> {
        await this._writeMutex.acquire();
        try {
            const chat = this.getChat(chatId);
            if (!chat) return;
            chat.title = title;
            chat.version = (chat.version || 0) + 1;
            this.saveChatFile(chat);
            const index = this.readIndex();
            const existing = index.find(c => c.id === chatId);
            if (existing) {
                existing.title = title;
                existing.version = (existing.version || 0) + 1;
            }
            this.writeIndex(index);
        } finally {
            this._writeMutex.release();
        }
    }
}
