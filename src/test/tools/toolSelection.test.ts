import * as assert from 'assert';
import { getTriggeredGroups, selectTools, estimateToolDefinitionTokens } from '../../tools/toolSelection';

suite('ToolSelection Tests', () => {

    suite('getTriggeredGroups', () => {
        test('returns core group for empty message (none triggered)', () => {
            const groups = getTriggeredGroups('');
            assert.ok(groups instanceof Set);
            assert.strictEqual(groups.size, 0);
        });

        test('triggers git group on "commit"', () => {
            const groups = getTriggeredGroups('I want to commit my changes');
            assert.ok(groups.has('git'));
        });

        test('triggers git group on "branch"', () => {
            const groups = getTriggeredGroups('create a new branch');
            assert.ok(groups.has('git'));
        });

        test('triggers git group on "git diff"', () => {
            const groups = getTriggeredGroups('show me the git diff');
            assert.ok(groups.has('git'));
        });

        test('triggers process group on "server"', () => {
            const groups = getTriggeredGroups('start the dev server');
            assert.ok(groups.has('process'));
        });

        test('triggers process group on "background process"', () => {
            const groups = getTriggeredGroups('run this in the background process');
            assert.ok(groups.has('process'));
        });

        test('triggers codeintel group on "refactor"', () => {
            const groups = getTriggeredGroups('refactor this function');
            assert.ok(groups.has('codeintel'));
        });

        test('triggers codeintel group on "definition"', () => {
            const groups = getTriggeredGroups('find the definition of Foo');
            assert.ok(groups.has('codeintel'));
        });

        test('triggers build group on "npm test"', () => {
            const groups = getTriggeredGroups('run npm test');
            assert.ok(groups.has('build'));
        });

        test('triggers build group on "compile"', () => {
            const groups = getTriggeredGroups('compile the project');
            assert.ok(groups.has('build'));
        });

        test('triggers checkpoint group on "checkpoint"', () => {
            const groups = getTriggeredGroups('create a checkpoint');
            assert.ok(groups.has('checkpoint'));
        });

        test('triggers task group on "todo"', () => {
            const groups = getTriggeredGroups('add a todo item');
            assert.ok(groups.has('task'));
        });

        test('triggers env group on "environment variable"', () => {
            const groups = getTriggeredGroups('check environment variable PATH');
            assert.ok(groups.has('env'));
        });

        // Browser group removed (P0-T2) — browser tools purged until P3-T3 Playwright implementation.
        test('triggers debug group on "breakpoint"', () => {
            const groups = getTriggeredGroups('set a breakpoint');
            assert.ok(groups.has('debug'));
        });

        test('triggers multiagent group on "spawn agent"', () => {
            const groups = getTriggeredGroups('spawn an agent to fix tests');
            assert.ok(groups.has('multiagent'));
        });

        test('triggers mcp group on "mcp"', () => {
            const groups = getTriggeredGroups('list mcp resources');
            assert.ok(groups.has('mcp'));
        });

        test('triggers skill group on "skill"', () => {
            const groups = getTriggeredGroups('load the pdf skill');
            assert.ok(groups.has('skill'));
        });

        test('triggers memory group on "remember"', () => {
            const groups = getTriggeredGroups('remember this preference');
            assert.ok(groups.has('memory'));
        });

        test('triggers web group on "search the web"', () => {
            const groups = getTriggeredGroups('search the web for hello world');
            assert.ok(groups.has('web'));
        });

        test('triggers web group on "fetch"', () => {
            const groups = getTriggeredGroups('fetch https://example.com');
            assert.ok(groups.has('web'));
        });

        test('triggers multiple groups when keywords overlap', () => {
            const groups = getTriggeredGroups('git commit and run npm test');
            assert.ok(groups.has('git'));
            assert.ok(groups.has('build'));
        });

        test('case-insensitive matching', () => {
            const groups = getTriggeredGroups('GIT COMMIT NOW');
            assert.ok(groups.has('git'));
        });

        test('does not trigger unrelated groups', () => {
            const groups = getTriggeredGroups('hello world how are you');
            assert.strictEqual(groups.size, 0);
        });
    });

    suite('selectTools', () => {
        test('returns all non-gated tools regardless of message content', () => {
            const tools1 = selectTools('fix the search function');
            const tools2 = selectTools('git commit please');
            const tools3 = selectTools();
            // All three calls should return the same set (no keyword filtering)
            assert.strictEqual(tools1.length, tools2.length);
            assert.strictEqual(tools2.length, tools3.length);
        });

        test('returns a reasonable number of tools (> 30)', () => {
            const tools = selectTools();
            assert.ok(tools.length > 30, `Expected >30 tools, got ${tools.length}`);
        });

        test('does NOT include multi-agent tools when flag is false', () => {
            const tools = selectTools();
            const names = tools.map(t => t.name);
            assert.ok(!names.includes('spawn_agent'), 'spawn_agent should be excluded');
            assert.ok(!names.includes('send_agent_message'), 'send_agent_message should be excluded');
            assert.ok(!names.includes('get_agent_status'), 'get_agent_status should be excluded');
            assert.ok(!names.includes('wait_for_agent'), 'wait_for_agent should be excluded');
            assert.ok(!names.includes('stop_agent'), 'stop_agent should be excluded');
        });

        test('does NOT include gated MCP tools when flag is false', () => {
            const tools = selectTools();
            const names = tools.map(t => t.name);
            assert.ok(!names.includes('list_mcp_resources'), 'list_mcp_resources should be excluded');
            assert.ok(!names.includes('read_mcp_resource'), 'read_mcp_resource should be excluded');
            assert.ok(!names.includes('invoke_mcp_tool'), 'invoke_mcp_tool should be excluded');
        });

        test('includes lightweight MCP stubs (search_tools, load_tool) regardless of flag', () => {
            const tools = selectTools();
            const names = tools.map(t => t.name);
            assert.ok(names.includes('search_tools'), 'search_tools should be included');
            assert.ok(names.includes('load_tool'), 'load_tool should be included');
        });
    });

    suite('estimateToolDefinitionTokens', () => {
        test('returns 0 for empty array', () => {
            assert.strictEqual(estimateToolDefinitionTokens([]), 0);
        });

        test('returns positive token count for selected tools', () => {
            const tools = selectTools();
            const tokens = estimateToolDefinitionTokens(tools);
            assert.ok(tokens > 0, `Expected positive token count, got ${tokens}`);
        });

        test('token count scales with tool count', () => {
            const tools = selectTools();
            const half = tools.slice(0, Math.floor(tools.length / 2));
            const fullTokens = estimateToolDefinitionTokens(tools);
            const halfTokens = estimateToolDefinitionTokens(half);
            assert.ok(fullTokens > halfTokens, 'Full set should have more tokens than half');
        });
    });
});
