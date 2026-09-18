import * as assert from 'assert';
import { PolicyEngine, PolicyConfig, PolicyDecision } from '../../tools/policyEngine';

suite('PolicyEngine Tests', () => {

    function makeInvocation(overrides?: Record<string, unknown>) {
        return {
            invocationId: 'inv_test_001',
            toolName: 'read_file',
            input: { path: 'src/test.ts' },
            workspaceId: '/workspace/test',
            sessionId: 'session-1',
            requestedAt: new Date().toISOString(),
            ...overrides,
        };
    }

    let engine: PolicyEngine;

    setup(() => {
        engine = new PolicyEngine();
    });

    suite('evaluate — allow decisions', () => {
        test('allows R0 safe tools', () => {
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R0' });
            assert.strictEqual(decision.decision, 'allow');
            assert.strictEqual(decision.riskClass, 'R0');
        });

        test('auto-approves R1 targeted edits when configured', () => {
            engine.updateConfig({ autoApproveTargetedEdits: true });
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R1' });
            assert.strictEqual(decision.decision, 'allow');
        });

        test('auto-approves R2 safe commands when configured', () => {
            engine.updateConfig({ autoApproveSafeCommands: true });
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R2' });
            assert.strictEqual(decision.decision, 'allow');
        });
    });

    suite('evaluate — require_approval decisions', () => {
        test('requires approval for R1 by default', () => {
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R1' });
            assert.strictEqual(decision.decision, 'require_approval');
        });

        test('requires approval for R2 by default', () => {
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R2' });
            assert.strictEqual(decision.decision, 'require_approval');
        });

        test('requires approval for R3 by default', () => {
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R3' });
            assert.strictEqual(decision.decision, 'require_approval');
        });

        test('includes approval scope options when approval required', () => {
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R1' });
            assert.ok(decision.approvalScopeOptions);
            assert.ok(decision.approvalScopeOptions!.includes('allow_once'));
            assert.ok(decision.approvalScopeOptions!.includes('deny'));
        });
    });

    suite('evaluate — deny decisions', () => {
        test('denies R5 high-impact tools', () => {
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R5' });
            assert.strictEqual(decision.decision, 'deny');
        });
    });

    suite('evaluate — command blocklist', () => {
        test('blocks rm -rf command', () => {
            const decision = engine.evaluate(makeInvocation({
                toolName: 'execute_command',
                input: { command: 'rm -rf /data' },
            }), { baseRisk: 'R2' });
            assert.strictEqual(decision.decision, 'deny');
            assert.ok(decision.reasons.some(r => r.includes('blocklist')));
        });

        test('blocks mkfs command', () => {
            const decision = engine.evaluate(makeInvocation({
                toolName: 'execute_command',
                input: { command: 'mkfs.ext4 /dev/sda' },
            }), { baseRisk: 'R2' });
            assert.strictEqual(decision.decision, 'deny');
        });

        test('allows non-blocklisted commands', () => {
            const decision = engine.evaluate(makeInvocation({
                toolName: 'execute_command',
                input: { command: 'ls -la' },
            }), { baseRisk: 'R2' });
            // R2 requires approval but is not denied by blocklist
            assert.notStrictEqual(decision.decision, 'deny');
        });

        test('blocklist is case-insensitive', () => {
            const decision = engine.evaluate(makeInvocation({
                toolName: 'execute_command',
                input: { command: 'RM -RF /DATA' },
            }), { baseRisk: 'R2' });
            assert.strictEqual(decision.decision, 'deny');
        });
    });

    suite('updateConfig', () => {
        test('updates blocked patterns', () => {
            engine.updateConfig({ blockedCommandPatterns: ['forbidden_cmd'] });
            const decision = engine.evaluate(makeInvocation({
                toolName: 'execute_command',
                input: { command: 'forbidden_cmd --help' },
            }), { baseRisk: 'R2' });
            assert.strictEqual(decision.decision, 'deny');
        });

        test('allows commands after removing from blocklist', () => {
            engine.updateConfig({ blockedCommandPatterns: [] });
            const decision = engine.evaluate(makeInvocation({
                toolName: 'execute_command',
                input: { command: 'rm -rf /tmp' },
            }), { baseRisk: 'R2' });
            assert.notStrictEqual(decision.decision, 'deny');
        });
    });

    suite('reasons', () => {
        test('includes risk class description in reasons', () => {
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R0' });
            assert.ok(decision.reasons.length > 0);
        });

        test('explains denial reason', () => {
            const decision = engine.evaluate(makeInvocation(), { baseRisk: 'R5' });
            assert.ok(decision.reasons.length > 0);
            assert.ok(decision.reasons[0].toLowerCase().includes('denied') || decision.reasons[0].toLowerCase().includes('r5'));
        });
    });
});
