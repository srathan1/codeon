import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ChatStore } from '../../storage/chatStore';
import { ChatCompletionMessage } from '../../types';

function createTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstore-test-'));
    return dir;
}

suite('ChatStore', () => {
    let globalRoot: string;

    setup(() => {
        globalRoot = createTempDir();
    });

    teardown(() => {
        fs.rmSync(globalRoot, { recursive: true, force: true });
    });

    test('createChat and listChats', () => {
        const store = new ChatStore(path.join(globalRoot, 'chats', 'workspace1'), globalRoot, 'workspace1');
        const chat = store.createChat('plan');
        assert.ok(chat.id.startsWith('chat-'));
        assert.strictEqual(chat.title, 'New Chat');
        assert.strictEqual(chat.mode, 'plan');

        const list = store.listChats();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].id, chat.id);
    });

    test('deleteChat removes from workspace-scoped storage', async () => {
        const store = new ChatStore(path.join(globalRoot, 'chats', 'workspace1'), globalRoot, 'workspace1');
        const chat = store.createChat('plan');

        await store.deleteChat(chat.id);
        assert.strictEqual(store.listChats().length, 0);
    });

    test('deleteChat removes from legacy global chats.json', async () => {
        // Create a legacy global chats.json with a chat
        const legacyIndex = path.join(globalRoot, 'chats.json');
        const legacyChat = {
            id: 'legacy-chat-1',
            title: 'Legacy Chat',
            mode: 'plan',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        fs.writeFileSync(legacyIndex, JSON.stringify([legacyChat], null, 2));

        // Also create individual chat file at global level
        fs.writeFileSync(
            path.join(globalRoot, `${legacyChat.id}.json`),
            JSON.stringify(legacyChat, null, 2)
        );

        // Delete via workspace-scoped store
        const store = new ChatStore(path.join(globalRoot, 'chats', 'workspace1'), globalRoot, 'workspace1');
        await store.deleteChat('legacy-chat-1');

        // Legacy index should no longer contain the chat
        const remaining = JSON.parse(fs.readFileSync(legacyIndex, 'utf8'));
        assert.strictEqual(remaining.length, 0);

        // Individual file should also be gone
        assert.strictEqual(fs.existsSync(path.join(globalRoot, `${legacyChat.id}.json`)), false);
    });

    test('deleteChat removes from other workspace subdirectories', async () => {
        // Create a chat in workspace2's storage
        const ws2Path = path.join(globalRoot, 'chats', 'workspace2');
        fs.mkdirSync(ws2Path, { recursive: true });
        const ws2Store = new ChatStore(ws2Path, globalRoot, 'workspace2');
        const chat = ws2Store.createChat('build');

        // Delete via workspace1's store (different workspace)
        const ws1Path = path.join(globalRoot, 'chats', 'workspace1');
        fs.mkdirSync(ws1Path, { recursive: true });
        const ws1Store = new ChatStore(ws1Path, globalRoot, 'workspace1');
        await ws1Store.deleteChat(chat.id);

        // Chat should be gone from workspace2
        assert.strictEqual(ws2Store.listChats().length, 0);

        // Verify listAllChats doesn't see it either
        const all = ChatStore.listAllChats(globalRoot);
        const found = all.find(c => c.id === chat.id);
        assert.strictEqual(found, undefined);
    });

    test('listAllChats aggregates global + workspace chats', () => {
        // Global legacy chat
        const legacyIndex = path.join(globalRoot, 'chats.json');
        const legacyChat = {
            id: 'global-1',
            title: 'Global Chat',
            mode: 'plan',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        fs.writeFileSync(legacyIndex, JSON.stringify([legacyChat], null, 2));

        // Workspace-scoped chat
        const wsPath = path.join(globalRoot, 'chats', 'myproject');
        fs.mkdirSync(wsPath, { recursive: true });
        const wsStore = new ChatStore(wsPath, globalRoot, 'myproject');
        wsStore.createChat('build');

        const all = ChatStore.listAllChats(globalRoot);
        assert.strictEqual(all.length, 2);
        assert.strictEqual(all.find(c => c.id === 'global-1')?.workspaceLabel, 'Global');
        assert.ok(all.find(c => c.workspaceLabel === 'myproject'));
    });

    test('deleteChat via workspace store removes from listAllChats', async () => {
        // Setup: global legacy + workspace chats
        const legacyIndex = path.join(globalRoot, 'chats.json');
        const legacyChat = {
            id: 'global-1',
            title: 'Global Chat',
            mode: 'plan',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        fs.writeFileSync(legacyIndex, JSON.stringify([legacyChat], null, 2));

        const wsPath = path.join(globalRoot, 'chats', 'myproject');
        fs.mkdirSync(wsPath, { recursive: true });
        const wsStore = new ChatStore(wsPath, globalRoot, 'myproject');
        const wsChat = wsStore.createChat('build');

        // Both visible in listAllChats
        assert.strictEqual(ChatStore.listAllChats(globalRoot).length, 2);

        // Delete global chat via workspace store
        await wsStore.deleteChat('global-1');
        assert.strictEqual(ChatStore.listAllChats(globalRoot).find(c => c.id === 'global-1'), undefined);
        assert.strictEqual(ChatStore.listAllChats(globalRoot).length, 1);

        // Delete workspace chat via workspace store
        await wsStore.deleteChat(wsChat.id);
        assert.strictEqual(ChatStore.listAllChats(globalRoot).length, 0);
    });

    test('updateTitle updates both index and individual file', async () => {
        const store = new ChatStore(path.join(globalRoot, 'chats', 'workspace1'), globalRoot, 'workspace1');
        const chat = store.createChat('plan');

        await store.updateTitle(chat.id, 'Renamed Chat');

        const updated = store.listChats()[0];
        assert.strictEqual(updated.title, 'Renamed Chat');

        // Individual file also updated
        const individual = JSON.parse(fs.readFileSync(
            path.join(globalRoot, 'chats', 'workspace1', `${chat.id}.json`), 'utf8'
        ));
        assert.strictEqual(individual.title, 'Renamed Chat');
    });

    test('saveMessages stores compacted messages + full transcript separately', async () => {
        const store = new ChatStore(path.join(globalRoot, 'chats', 'workspace1'), globalRoot, 'workspace1');
        const chat = store.createChat('plan');

        // Simulate compacted messages (summary + recent)
        const compactedMessages: ChatCompletionMessage[] = [
            { role: 'system', content: '## Conversation Summary\n\nEarlier discussion about X.' },
            { role: 'user', content: 'Continue with Y' },
        ];

        // Full transcript (pre-compaction history)
        const fullTranscript: ChatCompletionMessage[] = [
            { role: 'user', content: 'What is X?' },
            { role: 'assistant', content: 'X is a concept...' },
            { role: 'user', content: 'Explain more' },
            { role: 'assistant', content: 'Sure, here is more detail...' },
            { role: 'user', content: 'Continue with Y' },
        ];

        await store.saveMessages(chat.id, compactedMessages, undefined, fullTranscript);

        const retrieved = store.getChat(chat.id);
        assert.ok(retrieved);
        assert.strictEqual(retrieved.messages.length, 2, 'Should store compacted messages');
        assert.strictEqual(retrieved.transcript?.length, 5, 'Should store full transcript');
        assert.strictEqual(retrieved.transcript![0].content, 'What is X?');
    });

    test('index entry does not include transcript (keeps chats.json lightweight)', async () => {
        const store = new ChatStore(path.join(globalRoot, 'chats', 'workspace1'), globalRoot, 'workspace1');
        const chat = store.createChat('plan');

        const compacted: ChatCompletionMessage[] = [{ role: 'user', content: 'Hello' }];
        const transcript: ChatCompletionMessage[] = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hey' }];

        await store.saveMessages(chat.id, compacted, undefined, transcript);

        // Read the index directly
        const indexPath = path.join(globalRoot, 'chats', 'workspace1', 'chats.json');
        const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        const indexEntry = indexData.find((c: Record<string, unknown>) => c.id === chat.id);
        assert.strictEqual(indexEntry.transcript, undefined, 'Index should not contain transcript');
    });
});
