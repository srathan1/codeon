import * as assert from 'assert';
import { classifyRisk, requiresApproval, isDenied, RISK_DESCRIPTIONS, RISK_ORDER, legacyRiskToClass, RiskFactors } from '../../tools/riskModel';

suite('RiskModel Tests', () => {

    suite('classifyRisk', () => {
        function baseFactors(overrides?: Partial<RiskFactors>): RiskFactors {
            return { baseRisk: 'R0', ...overrides };
        }

        test('returns base risk when no escalation factors', () => {
            assert.strictEqual(classifyRisk(baseFactors({ baseRisk: 'R0' })), 'R0');
            assert.strictEqual(classifyRisk(baseFactors({ baseRisk: 'R2' })), 'R2');
        });

        test('escalates to R4 when accessesSecrets', () => {
            assert.strictEqual(classifyRisk(baseFactors({ baseRisk: 'R0', accessesSecrets: true })), 'R4');
            assert.strictEqual(classifyRisk(baseFactors({ baseRisk: 'R3', accessesSecrets: true })), 'R4');
        });

        test('escalates to R3 when targetsProtectedPath', () => {
            assert.strictEqual(classifyRisk(baseFactors({ baseRisk: 'R0', targetsProtectedPath: true })), 'R3');
            assert.strictEqual(classifyRisk(baseFactors({ baseRisk: 'R1', targetsProtectedPath: true })), 'R3');
        });

        test('escalates to R3 when isDestructive', () => {
            assert.strictEqual(classifyRisk(baseFactors({ baseRisk: 'R1', isDestructive: true })), 'R3');
        });

        test('escalates to R3 when modifiesHistory', () => {
            assert.strictEqual(classifyRisk(baseFactors({ baseRisk: 'R0', modifiesHistory: true })), 'R3');
        });

        test('escalates to R4 when hasExternalVisibility', () => {
            assert.strictEqual(classifyRisk(baseFactors({ baseRisk: 'R2', hasExternalVisibility: true })), 'R4');
        });

        test('escalates to highest factor when multiple present', () => {
            // R4 (accessesSecrets) > R3 (isDestructive)
            assert.strictEqual(classifyRisk(baseFactors({
                baseRisk: 'R0',
                isDestructive: true,
                accessesSecrets: true,
            })), 'R4');
        });

        test('detects destructive command patterns', () => {
            assert.strictEqual(classifyRisk(baseFactors({ command: 'rm -rf /tmp' })), 'R3');
            assert.strictEqual(classifyRisk(baseFactors({ command: 'rm -r /data' })), 'R3');
            assert.strictEqual(classifyRisk(baseFactors({ command: 'mkfs.ext4 /dev/sda' })), 'R3');
            assert.strictEqual(classifyRisk(baseFactors({ command: 'dd if=/dev/zero' })), 'R3');
        });

        test('detects production deployment patterns as R5', () => {
            assert.strictEqual(classifyRisk(baseFactors({ command: 'deploy --to prod' })), 'R5');
            assert.strictEqual(classifyRisk(baseFactors({ command: 'kubectl apply -f deploy.yaml' })), 'R5');
            assert.strictEqual(classifyRisk(baseFactors({ command: 'terraform apply' })), 'R5');
        });

        test('non-destructive commands do not escalate', () => {
            assert.strictEqual(classifyRisk(baseFactors({ command: 'ls -la' })), 'R0');
            assert.strictEqual(classifyRisk(baseFactors({ command: 'echo hello' })), 'R0');
        });
    });

    suite('requiresApproval', () => {
        test('R0 does not require approval', () => {
            assert.strictEqual(requiresApproval('R0'), false);
        });

        test('R1-R4 require approval', () => {
            assert.strictEqual(requiresApproval('R1'), true);
            assert.strictEqual(requiresApproval('R2'), true);
            assert.strictEqual(requiresApproval('R3'), true);
            assert.strictEqual(requiresApproval('R4'), true);
        });
    });

    suite('isDenied', () => {
        test('R5 is denied by default', () => {
            assert.strictEqual(isDenied('R5'), true);
        });

        test('R0-R4 are not denied', () => {
            assert.strictEqual(isDenied('R0'), false);
            assert.strictEqual(isDenied('R1'), false);
            assert.strictEqual(isDenied('R2'), false);
            assert.strictEqual(isDenied('R3'), false);
            assert.strictEqual(isDenied('R4'), false);
        });
    });

    suite('legacyRiskToClass', () => {
        test('maps safe to R0', () => {
            assert.strictEqual(legacyRiskToClass('safe'), 'R0');
        });

        test('maps moderate to R2', () => {
            assert.strictEqual(legacyRiskToClass('moderate'), 'R2');
        });

        test('maps dangerous to R3', () => {
            assert.strictEqual(legacyRiskToClass('dangerous'), 'R3');
        });
    });

    suite('RISK_ORDER', () => {
        test('ordering is monotonic', () => {
            assert.ok(RISK_ORDER['R0'] < RISK_ORDER['R1']);
            assert.ok(RISK_ORDER['R1'] < RISK_ORDER['R2']);
            assert.ok(RISK_ORDER['R2'] < RISK_ORDER['R3']);
            assert.ok(RISK_ORDER['R3'] < RISK_ORDER['R4']);
            assert.ok(RISK_ORDER['R4'] < RISK_ORDER['R5']);
        });
    });

    suite('RISK_DESCRIPTIONS', () => {
        test('all risk classes have descriptions', () => {
            for (const cls of ['R0', 'R1', 'R2', 'R3', 'R4', 'R5']) {
                assert.ok(RISK_DESCRIPTIONS[cls as keyof typeof RISK_DESCRIPTIONS], `Missing description for ${cls}`);
                assert.ok(RISK_DESCRIPTIONS[cls as keyof typeof RISK_DESCRIPTIONS].length > 0);
            }
        });
    });
});
