import * as assert from 'assert';
import { ProcessManager } from '../../tools/processManager';

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

suite('ProcessManager Tests', () => {
    let manager: ProcessManager;

    setup(() => {
        manager = new ProcessManager();
    });

    test('a process stopped via stop() reports status "stopped", not "error", even though it exits via signal', async () => {
        const proc = await manager.start('node -e "setInterval(()=>{}, 1000)"', process.cwd());
        assert.strictEqual(proc.status, 'running');

        await manager.stop(proc.id, 1000);
        const finalState = manager.get(proc.id);

        assert.ok(finalState, 'process should still be tracked after stop');
        assert.strictEqual(finalState!.status, 'stopped', 'a deliberate stop() must report "stopped", not "error"');
    });

    test('a process that exits naturally (no signal, no stop() call) reports status "stopped"', async () => {
        const proc = await manager.start('node -e "process.exit(0)"', process.cwd());

        await waitFor(() => manager.get(proc.id)?.status !== 'running');
        const finalState = manager.get(proc.id);

        assert.ok(finalState);
        assert.strictEqual(finalState!.status, 'stopped');
        assert.strictEqual(finalState!.exitCode, 0);
    });
});
