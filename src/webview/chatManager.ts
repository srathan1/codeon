import { ChatStore } from '../storage/chatStore';
import { ModeManager } from '../context/modeManager';
import { ContextManager } from '../context/contextManager';
import { ApiClient } from '../api/apiClient';
import { ChatCompletionMessage } from '../types';

export class ChatManager {
    /** Partial (interrupted) assistant message from last restore, sent to UI with a badge. */
    public partialTailMessage: { role: string; content: string } | null = null;

    constructor(
        private readonly chatStore: ChatStore,
        private readonly modeManager: ModeManager,
        private readonly contextManager: ContextManager,
        private readonly apiMessages: ChatCompletionMessage[],
        private readonly post: (message: Record<string, unknown>) => void,
        private readonly getActiveChatId: () => string | null,
        private readonly setActiveChatId: (id: string | null) => void,
        private readonly postChatList: (activeChatId: string | null) => void
    ) {}

    public restoreActiveChat(): void {
        const chatId = this.getActiveChatId();
        if (!chatId) return;
        const stored = this.chatStore.getChat(chatId);
        this.partialTailMessage = null; // reset

        if (stored && stored.messages.length > 0) {
            // Check if the last message was interrupted mid-stream (_partial flag).
            // If so, strip it from apiMessages (LLM never saw it) but still send to UI with marker.
            let messages = stored.messages;
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg._partial) {
                messages = messages.slice(0, -1);
                this.partialTailMessage = { role: lastMsg.role, content: lastMsg.content };
            }

            this.apiMessages.length = 0;
            this.apiMessages.push(...messages);
            this.modeManager.switchMode(stored.mode, false);
        } else if (stored) {
            this.apiMessages.length = 0;
            this.modeManager.switchMode(stored.mode, false);
        }
    }

    /** Get the stored transcript (full pre-compaction history) for display purposes. */
    public getStoredTranscript(): ChatCompletionMessage[] | undefined {
        const chatId = this.getActiveChatId();
        if (!chatId) return undefined;
        const stored = this.chatStore.getChat(chatId);
        if (!stored || !stored.transcript || stored.transcript.length === 0) return undefined;

        // Strip partial tail from transcript too
        const lastMsg = stored.transcript[stored.transcript.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg._partial) {
            return stored.transcript.slice(0, -1);
        }
        return stored.transcript;
    }

    public createNewChat(): void {
        const mode = this.modeManager.getCurrentMode();
        const chat = this.chatStore.createChat(mode);
        this.setActiveChatId(chat.id);
        this.apiMessages.length = 0;
        this.partialTailMessage = null;
        this.contextManager.clearContext();

        // Use loadMessages (empty) instead of clearMessages so the welcome /
        // empty state is explicitly shown and token count is reset.
        this.post({
            command: 'loadMessages',
            messages: [],
            mode,
            forceReload: true
        });
        this.postChatList(this.getActiveChatId());
    }

    public switchChat(chatId: string): void {
        this.setActiveChatId(chatId);
        this.restoreActiveChat();
        this.contextManager.clearContext();
        // Sync context after restoring
        this.contextManager.setApiMessages([...this.apiMessages]);

        this.postChatList(this.getActiveChatId());

        const msgs: Array<Record<string, unknown>> = this.apiMessages.map(m => ({
            role: m.role,
            content: m.content,
            tool_call_id: m.tool_call_id,
            tool_calls: m.tool_calls
        }));
        if (this.partialTailMessage) {
            msgs.push({ role: 'assistant', content: this.partialTailMessage.content, _partial: true });
        }
        this.post({
            command: 'loadMessages',
            messages: msgs,
            mode: this.modeManager.getCurrentMode(),
            forceReload: true
        });

        const config = ApiClient.getConfig();
        this.post({
            command: 'tokenCount',
            used: this.contextManager.getContextSize(),
            limit: config.contextWindowSize
        });
    }

    public async deleteChat(chatId: string): Promise<void> {
        // H-9: await the now-mutex-protected delete before reading state
        // back (listChats()/postChatList() below) — otherwise this could
        // read a stale index from before the delete actually landed.
        await this.chatStore.deleteChat(chatId);

        if (this.getActiveChatId() === chatId) {
            const chats = this.chatStore.listChats();
            if (chats.length > 0) {
                this.switchChat(chats[0].id);
            } else {
                this.createNewChat();
            }
        } else {
            // Refresh chat list and force-reload messages area so the UI stays consistent
            this.postChatList(this.getActiveChatId());
            this.post({
                command: 'loadMessages',
                messages: this.apiMessages.map(m => ({
                    role: m.role,
                    content: m.content,
                    tool_call_id: m.tool_call_id,
                    tool_calls: m.tool_calls
                })),
                mode: this.modeManager.getCurrentMode(),
                forceReload: true
            });
        }
    }

    public async renameChat(chatId: string, title: string): Promise<void> {
        await this.chatStore.updateTitle(chatId, title);
        this.postChatList(this.getActiveChatId());
    }

    public refreshChatList(): void {
        this.postChatList(this.getActiveChatId());
    }
}
