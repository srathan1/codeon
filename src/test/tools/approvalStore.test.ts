import * as assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
    initApprovalStore,
    isAutoApproved,
    addRule,
    removeRule,
    getRules,
    resetApprovalStore,
} from '../../tools/approvalStore';

suite('ApprovalStore', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resetApprovalStore();
    });

    test('isAutoApproved returns false when no rules exist', () => {
        initApprovalStore(tmpDir);
        assert.strictEqual(isAutoApproved('execute_command', 'dangerous'), false);
    });

    test('addRule persists and isAutoApproved returns true', () => {
        initApprovalStore(tmpDir);
        addRule('execute_command', 'dangerous');
        assert.strictEqual(isAutoApproved('execute_command', 'dangerous'), true);
        assert.strictEqual(isAutoApproved('write_file', 'dangerous'), false);
        assert.strictEqual(isAutoApproved('execute_command', 'moderate'), false);
    });

    test('wildcard toolName matches all tools at risk level', () => {
        initApprovalStore(tmpDir);
        addRule('*', 'dangerous');
        assert.strictEqual(isAutoApproved('execute_command', 'dangerous'), true);
        assert.strictEqual(isAutoApproved('write_file', 'dangerous'), true);
        assert.strictEqual(isAutoApproved('execute_command', 'moderate'), false);
    });

    test('duplicate addRule does not create duplicate entries', () => {
        initApprovalStore(tmpDir);
        addRule('execute_command', 'dangerous');
        addRule('execute_command', 'dangerous');
        const rules = getRules();
        assert.strictEqual(rules.length, 1);
    });

    test('removeRule removes by id', () => {
        initApprovalStore(tmpDir);
        const rule = addRule('execute_command', 'dangerous');
        assert.strictEqual(isAutoApproved('execute_command', 'dangerous'), true);
        assert.strictEqual(removeRule(rule.id), true);
        assert.strictEqual(isAutoApproved('execute_command', 'dangerous'), false);
    });

    test('removeRule returns false for non-existent id', () => {
        initApprovalStore(tmpDir);
        assert.strictEqual(removeRule('nonexistent'), false);
    });

    test('rules persist across reload', () => {
        initApprovalStore(tmpDir);
        addRule('execute_command', 'dangerous');

        // Simulate reload by resetting and re-initializing
        resetApprovalStore();
        initApprovalStore(tmpDir);

        assert.strictEqual(isAutoApproved('execute_command', 'dangerous'), true);
    });

    test('getRules returns a copy', () => {
        initApprovalStore(tmpDir);
        addRule('execute_command', 'dangerous');
        const rules1 = getRules();
        const rules2 = getRules();
        assert.notStrictEqual(rules1, rules2);
        assert.strictEqual(rules1.length, rules2.length);
    });

    test('works without workspace root (no-op)', () => {
        // Don't init — should be safe no-op
        assert.strictEqual(isAutoApproved('anything', 'anything'), false);
    });

    test('corrupt JSON file starts fresh', () => {
        initApprovalStore(tmpDir);
        const filePath = path.join(tmpDir, '.codeon', 'approval-rules.json');
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, '{invalid json', 'utf8');

        // Reset and reload — should handle gracefully
        resetApprovalStore();
        initApprovalStore(tmpDir);

        assert.strictEqual(isAutoApproved('anything', 'anything'), false);
        // Should still be able to write new rules
        addRule('test_tool', 'safe');
        assert.strictEqual(isAutoApproved('test_tool', 'safe'), true);
    });
});
