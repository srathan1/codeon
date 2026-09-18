import * as assert from 'assert';
import * as sinon from 'sinon';
import { MessageRouter, MessageRouterHandlers } from '../../webview/messageRouter';

/** Build a handlers object with every callback stubbed via sinon. */
function makeHandlers(): { handlers: MessageRouterHandlers; spies: Record<keyof MessageRouterHandlers, sinon.SinonSpy> } {
    const spies = {
        onSendMessage: sinon.spy(),
        onForceSendMessage: sinon.spy(),
        onAttachFile: sinon.spy(),
        onGetConfig: sinon.spy(),
        onListModels: sinon.spy(),
        onSwitchModel: sinon.spy(),
        onAddModel: sinon.spy(),
        onBulkAddModels: sinon.spy(),
        onAddModelToProvider: sinon.spy(),
        onUpdateProvider: sinon.spy(),
        onUpdateModel: sinon.spy(),
        onDeleteModel: sinon.spy(),
        onDeleteProvider: sinon.spy(),
        onResetAllModels: sinon.spy(),
        onNewChat: sinon.spy(),
        onSwitchChat: sinon.spy(),
        onDeleteChat: sinon.spy(),
        onRenameChat: sinon.spy(),
        onToolApprovalResponse: sinon.spy(),
        onRemoveRetrievedChunk: sinon.spy(),
        onRegenerate: sinon.spy(),
        onCompact: sinon.spy(),
        onStopGeneration: sinon.spy(),
        onSetEditMode: sinon.spy(),
        onAcceptDiff: sinon.spy(),
        onRejectDiff: sinon.spy(),
        onQuestionResponse: sinon.spy(),
        onPlanModeExitRequest: sinon.spy(),
        onPlanModeToolResponse: sinon.spy(),
        onSetInteractionMode: sinon.spy(),
        onExpandHistory: sinon.spy(),
    } as unknown as Record<keyof MessageRouterHandlers, sinon.SinonSpy>;
    return { handlers: spies as unknown as MessageRouterHandlers, spies };
}

suite('MessageRouter Tests', () => {
    test('sendMessage routes text and mode to onSendMessage', () => {
        const { handlers, spies } = makeHandlers();
        new MessageRouter(handlers).route({ command: 'sendMessage', text: 'hello', mode: 'build' });
        assert.strictEqual(spies.onSendMessage.calledOnceWith('hello', 'build'), true);
    });

    test('sendMessage defaults mode to plan when absent', () => {
        const { handlers, spies } = makeHandlers();
        new MessageRouter(handlers).route({ command: 'sendMessage', text: 'hi' });
        assert.strictEqual(spies.onSendMessage.calledOnceWith('hi', 'plan'), true);
    });

    test('switchModel passes undefined providerName when absent', () => {
        const { handlers, spies } = makeHandlers();
        new MessageRouter(handlers).route({ command: 'switchModel', modelName: 'gpt-4' });
        assert.strictEqual(spies.onSwitchModel.calledOnceWith('gpt-4', undefined), true);
    });

    test('bulkAddModels parses the current `models` shape', () => {
        const { handlers, spies } = makeHandlers();
        new MessageRouter(handlers).route({
            command: 'bulkAddModels',
            providerName: 'openai',
            providerEndpoint: 'https://api.openai.com',
            providerApiKey: 'sk-1',
            models: [{ name: 'gpt-4', contextWindowSize: 128000 }, { name: 'gpt-3.5' }],
        });
        assert.strictEqual(spies.onBulkAddModels.calledOnce, true);
        const modelSpecs = spies.onBulkAddModels.getCall(0).args[3];
        assert.deepStrictEqual(modelSpecs, [
            { name: 'gpt-4', contextWindowSize: 128000 },
            { name: 'gpt-3.5', contextWindowSize: undefined },
        ]);
    });

    test('bulkAddModels falls back to legacy `modelNames: string[]` shape', () => {
        const { handlers, spies } = makeHandlers();
        new MessageRouter(handlers).route({
            command: 'bulkAddModels',
            providerName: 'openai',
            providerEndpoint: '',
            providerApiKey: '',
            modelNames: ['gpt-4', 'gpt-3.5'],
        });
        const modelSpecs = spies.onBulkAddModels.getCall(0).args[3];
        assert.deepStrictEqual(modelSpecs, [{ name: 'gpt-4' }, { name: 'gpt-3.5' }]);
    });

    test('toolApprovalResponse forwards scope', () => {
        const { handlers, spies } = makeHandlers();
        new MessageRouter(handlers).route({ command: 'toolApprovalResponse', toolId: 't1', approved: true, scope: 'session' });
        assert.strictEqual(spies.onToolApprovalResponse.calledOnceWith('t1', true, 'session'), true);
    });

    test('deleteChat coerces chatId to string', () => {
        const { handlers, spies } = makeHandlers();
        new MessageRouter(handlers).route({ command: 'deleteChat', chatId: 'chat-abc' });
        assert.strictEqual(spies.onDeleteChat.calledOnceWith('chat-abc'), true);
    });

    test('openSettings/openLogs/rebuildIndex are no-ops (handled by caller upstream)', () => {
        const { handlers, spies } = makeHandlers();
        const router = new MessageRouter(handlers);
        router.route({ command: 'openSettings' });
        router.route({ command: 'openLogs' });
        router.route({ command: 'rebuildIndex' });
        for (const spy of Object.values(spies)) {
            assert.strictEqual(spy.called, false);
        }
    });

    test('unknown command is silently ignored', () => {
        const { handlers, spies } = makeHandlers();
        new MessageRouter(handlers).route({ command: 'totallyNotACommand' });
        for (const spy of Object.values(spies)) {
            assert.strictEqual(spy.called, false);
        }
    });

    test('openFile is not routed here — chatViewProvider handles it before calling route()', () => {
        const { handlers, spies } = makeHandlers();
        new MessageRouter(handlers).route({ command: 'openFile', path: 'src/index.ts' });
        for (const spy of Object.values(spies)) {
            assert.strictEqual(spy.called, false);
        }
    });

    test('setEditMode forwards the whole message object', () => {
        const { handlers, spies } = makeHandlers();
        const message = { command: 'setEditMode', mode: 'diff', extra: 42 };
        new MessageRouter(handlers).route(message);
        assert.strictEqual(spies.onSetEditMode.calledOnceWith(message), true);
    });
});
