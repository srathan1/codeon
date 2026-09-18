import * as assert from 'assert';
import { SpawnAgentExecutor, SendAgentMessageExecutor, GetAgentStatusExecutor, WaitForAgentExecutor, StopAgentExecutor, getAgentManager } from '../../tools/executors/agentOrchestrator';

suite('AgentOrchestrator Tests', () => {

    suite('SpawnAgentExecutor', () => {
        const executor = new SpawnAgentExecutor();

        test('valid spawn returns agent ID and summary', async () => {
            const result = await executor.execute({
                prompt: 'Do something useful',
                toolAllowlist: 'read_file,grep_search',
            });

            assert.strictEqual(result.success, true);
            assert.ok(result.output);
            const parsed = JSON.parse(result.output);
            assert.ok(parsed.id.startsWith('agent-'));
            assert.strictEqual(parsed.status, 'running');
            assert.deepStrictEqual(parsed.toolAllowlist, ['read_file', 'grep_search']);
            assert.strictEqual(parsed.messageCount, 1);
            assert.strictEqual(parsed.worktree, undefined);
            assert.ok(typeof parsed.createdAt === 'number');
            assert.ok(typeof parsed.lastActivity === 'number');
        });

        test('spawn with worktree includes it in output', async () => {
            const result = await executor.execute({
                prompt: 'Work in a branch',
                toolAllowlist: 'git',
                worktree: '/tmp/worktree-1',
            });

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.worktree, '/tmp/worktree-1');
        });

        test('missing prompt returns error', async () => {
            const result = await executor.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('prompt'));
        });

        test('empty string prompt returns error', async () => {
            const result = await executor.execute({ prompt: '' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('prompt'));
        });

        test('concurrency limit exceeded when 4th agent is spawned', async () => {
            // Spawn 3 agents to fill the concurrency limit (maxConcurrent = 3)
            const spawns = [];
            for (let i = 0; i < 3; i++) {
                const r = await executor.execute({
                    prompt: `Concurrency filler ${i}`,
                    toolAllowlist: '',
                });
                assert.strictEqual(r.success, true, `spawn ${i} should succeed`);
                spawns.push(JSON.parse(r.output));
            }

            // The 4th spawn must fail
            const fourth = await executor.execute({
                prompt: 'I should be blocked',
                toolAllowlist: '',
            });
            assert.strictEqual(fourth.success, false);
            assert.ok(fourth.error?.includes('CONCURRENCY_LIMIT'));

            // Free a slot by stopping one of the spawned agents so later tests don't hit the limit
            const stopExec = new StopAgentExecutor();
            for (const s of spawns) {
                await stopExec.execute({ agentId: s.id });
            }
        });
    });

    suite('SendAgentMessageExecutor', () => {
        const sendExec = new SendAgentMessageExecutor();
        const spawnExec = new SpawnAgentExecutor();

        test('send to running agent succeeds', async () => {
            // Spawn a fresh agent
            const spawnResult = await spawnExec.execute({
                prompt: 'Ready for messages',
                toolAllowlist: '',
            });
            const agent = JSON.parse(spawnResult.output);

            const result = await sendExec.execute({
                agentId: agent.id,
                message: 'Hello from test',
            });

            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.agentId, agent.id);
            assert.strictEqual(parsed.queued, true);
            assert.strictEqual(parsed.messageCount, 2); // initial prompt + 1 message

            // Clean up
            const stopExec = new StopAgentExecutor();
            await stopExec.execute({ agentId: agent.id });
        });

        test('send to nonexistent agent fails', async () => {
            const result = await sendExec.execute({
                agentId: 'agent-nonexistent-xyz',
                message: 'hello',
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('AGENT_NOT_FOUND'));
        });

        test('send to terminal agent fails', async () => {
            // Spawn and immediately stop an agent
            const spawnResult = await spawnExec.execute({
                prompt: 'Will be stopped',
                toolAllowlist: '',
            });
            const agent = JSON.parse(spawnResult.output);

            const stopExec = new StopAgentExecutor();
            await stopExec.execute({ agentId: agent.id });

            const result = await sendExec.execute({
                agentId: agent.id,
                message: 'should fail',
            });

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('AGENT_TERMINAL'));
            assert.ok(result.error?.includes('stopped'));
        });

        test('missing agentId returns error', async () => {
            const result = await sendExec.execute({ message: 'hello' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('agentId'));
        });

        test('missing message returns error', async () => {
            const result = await sendExec.execute({ agentId: 'x' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('message'));
        });
    });

    suite('GetAgentStatusExecutor', () => {
        const statusExec = new GetAgentStatusExecutor();
        const spawnExec = new SpawnAgentExecutor();

        test('get status of existing agent', async () => {
            const spawnResult = await spawnExec.execute({
                prompt: 'Status check target',
                toolAllowlist: 'tool_a,tool_b',
            });
            const agent = JSON.parse(spawnResult.output);

            const result = await statusExec.execute({ agentId: agent.id });
            assert.strictEqual(result.success, true);

            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.id, agent.id);
            assert.strictEqual(parsed.status, 'running');
            assert.deepStrictEqual(parsed.toolAllowlist, ['tool_a', 'tool_b']);
            assert.strictEqual(parsed.messageCount, 1);
            assert.strictEqual(parsed.toolUsageCount, 0);

            // Clean up
            const stopExec = new StopAgentExecutor();
            await stopExec.execute({ agentId: agent.id });
        });

        test('get status of nonexistent agent fails', async () => {
            const result = await statusExec.execute({ agentId: 'agent-nope' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('AGENT_NOT_FOUND'));
        });

        test('missing agentId returns error', async () => {
            const result = await statusExec.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('agentId'));
        });
    });

    suite('WaitForAgentExecutor', () => {
        const waitExec = new WaitForAgentExecutor();
        const spawnExec = new SpawnAgentExecutor();
        const stopExec = new StopAgentExecutor();

        test('wait for already-stopped agent returns immediately', async () => {
            // Spawn and stop an agent
            const spawnResult = await spawnExec.execute({
                prompt: 'Quick stop',
                toolAllowlist: '',
            });
            const agent = JSON.parse(spawnResult.output);
            await stopExec.execute({ agentId: agent.id });

            const before = Date.now();
            const result = await waitExec.execute({
                agentId: agent.id,
                timeoutMs: 5000,
            });
            const elapsed = Date.now() - before;

            assert.strictEqual(result.success, false); // success only for 'completed' status; 'stopped' is not 'completed'
            assert.ok(result.output);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.status, 'stopped');
            assert.strictEqual(parsed.waited, true);
            // Should return quickly since agent is already terminal
            assert.ok(elapsed < 2000, `wait took ${elapsed}ms, expected near-instant`);
        });

        test('timeout when agent never completes', async () => {
            // Spawn an agent that stays running forever
            const spawnResult = await spawnExec.execute({
                prompt: 'Never finishes',
                toolAllowlist: '',
            });
            const agent = JSON.parse(spawnResult.output);

            const before = Date.now();
            const result = await waitExec.execute({
                agentId: agent.id,
                timeoutMs: 500,
            });
            const elapsed = Date.now() - before;

            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('TIMEOUT'));
            assert.ok(elapsed >= 400, `timeout returned too fast (${elapsed}ms)`);

            // Clean up the still-running agent
            await stopExec.execute({ agentId: agent.id });
        });

        test('wait for nonexistent agent fails', async () => {
            const result = await waitExec.execute({
                agentId: 'agent-gone',
                timeoutMs: 500,
            });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('AGENT_NOT_FOUND'));
        });

        test('missing agentId returns error', async () => {
            const result = await waitExec.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('agentId'));
        });
    });

    suite('StopAgentExecutor', () => {
        const stopExec = new StopAgentExecutor();
        const spawnExec = new SpawnAgentExecutor();

        test('stop running agent succeeds', async () => {
            const spawnResult = await spawnExec.execute({
                prompt: 'To be stopped',
                toolAllowlist: '',
            });
            const agent = JSON.parse(spawnResult.output);

            const result = await stopExec.execute({ agentId: agent.id });
            assert.strictEqual(result.success, true);

            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.agentId, agent.id);
            assert.strictEqual(parsed.status, 'stopped');
            assert.strictEqual(parsed.stopped, true);
        });

        test('stop nonexistent agent fails', async () => {
            const result = await stopExec.execute({ agentId: 'agent-does-not-exist' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('AGENT_NOT_FOUND'));
        });

        test('missing agentId returns error', async () => {
            const result = await stopExec.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('agentId'));
        });

        test('stopping an already-stopped agent still succeeds', async () => {
            const spawnResult = await spawnExec.execute({
                prompt: 'Double stop',
                toolAllowlist: '',
            });
            const agent = JSON.parse(spawnResult.output);

            await stopExec.execute({ agentId: agent.id });
            const secondStop = await stopExec.execute({ agentId: agent.id });

            // stopAgent always returns true for an existing agent even if already stopped
            assert.strictEqual(secondStop.success, true);
        });
    });

    // P5-T5: an agent spawned by one chat must be invisible to tool calls made
    // from a different chat, and the concurrency cap must be per-chat. These
    // exercise AgentManager directly rather than through the executors, so the
    // assertions don't race the real background SubAgentLoop (which would
    // otherwise transition agents to a terminal state at nondeterministic times).
    suite('Per-chat agent scoping (P5-T5)', () => {
        const mgr = getAgentManager();

        test('getOwnedAgent hides an agent from a different chat', () => {
            const spawned = mgr.spawn('Owned by A', [], undefined, 'chat-A');
            assert.notStrictEqual(typeof spawned, 'string', 'spawn should succeed');
            const agentId = (spawned as { id: string }).id;

            // Wrong chat → not visible.
            assert.strictEqual(mgr.getOwnedAgent(agentId, 'chat-B'), undefined);
            // Owning chat → visible.
            assert.ok(mgr.getOwnedAgent(agentId, 'chat-A'));

            mgr.clearChatAgents('chat-A');
            // After clearing chat A's agents, even the owner can't see it.
            assert.strictEqual(mgr.getOwnedAgent(agentId, 'chat-A'), undefined);
        });

        test('concurrency cap is counted per-chat, not globally', () => {
            // Fill chat cap-A's 3 slots directly via the manager (no loops).
            for (let i = 0; i < 3; i++) {
                const r = mgr.spawn(`A filler ${i}`, [], undefined, 'chat-cap-A');
                assert.notStrictEqual(typeof r, 'string', `A spawn ${i} should succeed`);
            }
            // 4th in chat cap-A is blocked.
            const overflow = mgr.spawn('A overflow', [], undefined, 'chat-cap-A');
            assert.strictEqual(typeof overflow, 'string');
            assert.ok((overflow as string).includes('CONCURRENCY_LIMIT'));

            // A different chat still has all its own slots free.
            const other = mgr.spawn('B is unaffected', [], undefined, 'chat-cap-B');
            assert.notStrictEqual(typeof other, 'string', 'a busy chat must not starve a different chat');

            mgr.clearChatAgents('chat-cap-A');
            mgr.clearChatAgents('chat-cap-B');
        });

        test('clearChatAgents only removes the targeted chat', () => {
            mgr.spawn('keep me', [], undefined, 'chat-keep');
            const doomed = mgr.spawn('remove me', [], undefined, 'chat-doomed');
            const keepId = (mgr.spawn('also keep', [], undefined, 'chat-keep') as { id: string }).id;

            mgr.clearChatAgents('chat-doomed');
            assert.strictEqual(mgr.getOwnedAgent((doomed as { id: string }).id, 'chat-doomed'), undefined);
            assert.ok(mgr.getOwnedAgent(keepId, 'chat-keep'), 'unrelated chat agents must survive');

            mgr.clearChatAgents('chat-keep');
        });
    });

    // Regression: a stopped or errored agent must report FAILURE to the parent
    // via wait_for_agent — never success with partial output. Previously the
    // abort path emitted a 'completed' event that flipped the agent's status to
    // 'completed', so wait_for_agent said success and the model concluded it
    // "got what it wanted from the agent."
    suite('wait_for_agent reports stop/fail as failure, not success', () => {
        const mgr = getAgentManager();

        function agentInStatus(chatId: string, status: 'completed' | 'error' | 'stopped', error?: string) {
            const rec = mgr.spawn('do work', [], undefined, chatId) as { id: string };
            const live = mgr.getOwnedAgent(rec.id, chatId)!;
            live.status = status;
            live._partialOutput = 'partial progress so far...';
            if (error) live.error = error;
            return rec.id;
        }

        test('a stopped agent → success:false, cancelled, with a do-not-trust-partial message', async () => {
            const id = agentInStatus('wa-stop', 'stopped');
            const wait = new WaitForAgentExecutor();
            wait.setChatId('wa-stop');

            const result = await wait.execute({ agentId: id, timeoutMs: 500 });
            assert.strictEqual(result.success, false, 'a stopped agent must not read as success');
            assert.ok(result.error && result.error.includes('CANCELLED'));
            assert.ok(/partial|do not treat/i.test(result.error!), 'model must be told the output is partial');
            assert.strictEqual(JSON.parse(result.output).cancelled, true);

            mgr.clearChatAgents('wa-stop');
        });

        test('an errored agent → success:false with the error surfaced', async () => {
            const id = agentInStatus('wa-err', 'error', 'boom: API 500');
            const wait = new WaitForAgentExecutor();
            wait.setChatId('wa-err');

            const result = await wait.execute({ agentId: id, timeoutMs: 500 });
            assert.strictEqual(result.success, false);
            assert.ok(result.error && result.error.includes('AGENT_FAILED'));
            assert.ok(result.error!.includes('boom: API 500'));

            mgr.clearChatAgents('wa-err');
        });

        test('a genuinely completed agent → success:true', async () => {
            const id = agentInStatus('wa-ok', 'completed');
            const wait = new WaitForAgentExecutor();
            wait.setChatId('wa-ok');

            const result = await wait.execute({ agentId: id, timeoutMs: 500 });
            assert.strictEqual(result.success, true);

            mgr.clearChatAgents('wa-ok');
        });
    });
});
