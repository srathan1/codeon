import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuditLogger, configureAuditLogger, AuditEvent } from '../../tools/auditLogger';

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
    return {
        timestamp: new Date().toISOString(),
        eventId: 'evt-1',
        sessionId: 'session-1',
        toolName: 'read_file',
        riskClass: 'R0',
        sanitizedInputs: {},
        outcome: 'success',
        durationMs: 1,
        policyVersion: '1.0.0',
        ...overrides,
    };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

suite('AuditLogger Tests', () => {
    let tmpDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeon-audit-test-'));
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('S-2: writes the audit log under the configured global storage dir, not a workspace-relative path', async () => {
        configureAuditLogger(tmpDir);
        const logger = new AuditLogger();
        logger.record(makeEvent());
        logger.dispose(); // forces an immediate flush instead of waiting for the 2s timer

        const expectedPath = path.join(tmpDir, 'audit.jsonl');
        await waitFor(() => fs.existsSync(expectedPath));

        const content = fs.readFileSync(expectedPath, 'utf8');
        assert.ok(content.includes('"toolName":"read_file"'));

        // No .codeon directory should have been created anywhere as a side effect.
        assert.strictEqual(fs.existsSync(path.join(tmpDir, '.codeon')), false);
    });

    test('S-2: reuses the same resolved log path across multiple record()/flush cycles', async () => {
        configureAuditLogger(tmpDir);
        const logger = new AuditLogger();
        logger.record(makeEvent({ eventId: 'evt-a' }));
        logger.dispose();

        const expectedPath = path.join(tmpDir, 'audit.jsonl');
        await waitFor(() => fs.existsSync(expectedPath));

        const logger2 = new AuditLogger();
        logger2.record(makeEvent({ eventId: 'evt-b' }));
        logger2.dispose();

        await waitFor(() => {
            const content = fs.readFileSync(expectedPath, 'utf8');
            return content.includes('evt-a') && content.includes('evt-b');
        });
    });
});
