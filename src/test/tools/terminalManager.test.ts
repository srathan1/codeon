import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { TerminalManager } from '../../tools/terminalManager';

suite('TerminalManager', () => {
    let manager: TerminalManager;
    let createTerminalStub: sinon.SinonStub;
    let mockTerminal: vscode.Terminal;

    setup(() => {
        manager = new TerminalManager();
        mockTerminal = {
            name: 'CodeOn',
            processId: Promise.resolve(undefined),
            creationOptions: {},
            exitStatus: undefined,
            state: {} as vscode.TerminalState,
            sendText: sinon.stub(),
            show: sinon.stub(),
            hide: sinon.stub(),
            dispose: sinon.stub(),
        };
        createTerminalStub = sinon.stub(vscode.window, 'createTerminal').returns(mockTerminal);
    });

    teardown(() => {
        sinon.restore();
    });

    test('getOrCreateTerminal creates terminal when none exists', () => {
        const terminal = manager.getOrCreateTerminal();
        assert.strictEqual(createTerminalStub.callCount, 1);
        assert.strictEqual(terminal, mockTerminal);
        assert.deepStrictEqual(createTerminalStub.getCall(0).args[0], { name: 'CodeOn' });
    });

    test('getOrCreateTerminal returns same terminal on second call', () => {
        const first = manager.getOrCreateTerminal();
        const second = manager.getOrCreateTerminal();
        assert.strictEqual(first, second);
        assert.strictEqual(createTerminalStub.callCount, 1);
    });

    test('dispose kills the terminal', () => {
        manager.getOrCreateTerminal();
        manager.dispose();
        assert.strictEqual((mockTerminal.dispose as sinon.SinonStub).callCount, 1);
    });

    test('sendCommand sends text to terminal', () => {
        manager.sendCommand('echo hello');
        assert.strictEqual((mockTerminal.sendText as sinon.SinonStub).callCount, 1);
        assert.strictEqual((mockTerminal.sendText as sinon.SinonStub).getCall(0).args[0], 'echo hello');
    });

    test('sendCommand reveals terminal by default', () => {
        manager.sendCommand('echo hello');
        assert.strictEqual((mockTerminal.show as sinon.SinonStub).callCount, 1);
    });

    test('sendCommand does not reveal terminal when reveal is false', () => {
        manager.sendCommand('echo hello', false);
        assert.strictEqual((mockTerminal.show as sinon.SinonStub).callCount, 0);
    });

    test('isAlive returns true when terminal is running', () => {
        manager.getOrCreateTerminal();
        assert.strictEqual(manager.isAlive(), true);
    });

    test('isAlive returns false after dispose', () => {
        manager.getOrCreateTerminal();
        manager.dispose();
        assert.strictEqual(manager.isAlive(), false);
    });

    test('isAlive returns false before terminal is created', () => {
        assert.strictEqual(manager.isAlive(), false);
    });

    test('getOrCreateTerminal creates new terminal after old one exits', () => {
        const first = manager.getOrCreateTerminal();
        (mockTerminal as vscode.Terminal & { exitStatus: unknown }).exitStatus = { code: 0 } as vscode.TerminalExitStatus;
        const second = manager.getOrCreateTerminal();
        assert.notStrictEqual(first, second);
        assert.strictEqual(createTerminalStub.callCount, 2);
    });
});
