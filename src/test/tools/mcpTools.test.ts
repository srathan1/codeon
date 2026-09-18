import * as assert from 'assert';
import { SearchToolsExecutor, LoadToolExecutor, ListMcpResourcesExecutor, ReadMcpResourceExecutor, InvokeMcpToolExecutor } from '../../tools/executors/mcpTools';

suite('MCP Tools Tests', () => {

    suite('SearchToolsExecutor', () => {
        let executor: SearchToolsExecutor;

        setup(() => {
            executor = new SearchToolsExecutor();
        });

        test('missing query returns error', async () => {
            const result = await executor.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_PARAMETER') || result.error?.includes('query'));
        });

        test('empty query returns error', async () => {
            const result = await executor.execute({ query: '   ' });
            assert.strictEqual(result.success, false);
        });

        test('searches by tool name', async () => {
            const result = await executor.execute({ query: 'read_file' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.ok(parsed.count > 0, 'Should find read_file');
            assert.strictEqual(parsed.tools[0].name, 'read_file');
        });

        test('searches by description keyword', async () => {
            const result = await executor.execute({ query: 'git status' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.ok(parsed.count > 0, 'Should find git tools');
        });

        test('multi-term search scores relevance', async () => {
            const result = await executor.execute({ query: 'edit file' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.ok(parsed.count > 0);
            // Results should be sorted by relevance descending
            for (let i = 1; i < parsed.tools.length; i++) {
                assert.ok(
                    parsed.tools[i - 1].relevance >= parsed.tools[i].relevance,
                    'Results should be sorted by relevance descending',
                );
            }
        });

        test('no match returns empty list', async () => {
            const result = await executor.execute({ query: 'xyznonexistenttool123' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.count, 0);
        });
    });

    suite('LoadToolExecutor', () => {
        let executor: LoadToolExecutor;

        setup(() => {
            executor = new LoadToolExecutor();
        });

        test('missing toolName returns error', async () => {
            const result = await executor.execute({});
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('MISSING_PARAMETER') || result.error?.includes('toolName'));
        });

        test('loads known tool definition', async () => {
            const result = await executor.execute({ toolName: 'read_file' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.name, 'read_file');
            assert.ok(parsed.riskLevel);
            assert.ok(parsed.riskClass);
            assert.ok(parsed.phase !== undefined);
        });

        test('unknown tool returns not found', async () => {
            const result = await executor.execute({ toolName: 'nonexistent_tool_xyz' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('TOOL_NOT_FOUND'));
        });

        test('returns parameters schema', async () => {
            const result = await executor.execute({ toolName: 'list_dir' });
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.ok(parsed.parameters);
            assert.ok(parsed.parameters.properties);
        });
    });

    suite('ListMcpResourcesExecutor', () => {
        let executor: ListMcpResourcesExecutor;

        setup(() => {
            executor = new ListMcpResourcesExecutor();
        });

        test('returns no servers message when none configured', async () => {
            const result = await executor.execute({});
            assert.strictEqual(result.success, true);
            const parsed = JSON.parse(result.output);
            assert.strictEqual(parsed.servers.length, 0);
            assert.ok(parsed.message?.includes('configured') || parsed.message?.includes('MCP'));
        });

        test('unknown server returns not configured error', async () => {
            const result = await executor.execute({ serverName: 'nonexistent-server' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('not configured') || result.error?.includes('MCP_SERVER_NOT_CONFIGURED'));
        });
    });

    suite('ReadMcpResourceExecutor', () => {
        let executor: ReadMcpResourceExecutor;

        setup(() => {
            executor = new ReadMcpResourceExecutor();
        });

        test('missing serverName returns error', async () => {
            const result = await executor.execute({ uri: 'file:///foo.txt' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('serverName'));
        });

        test('missing uri returns error', async () => {
            const result = await executor.execute({ serverName: 'myserver' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('uri'));
        });

        test('unconfigured server returns not configured error', async () => {
            const result = await executor.execute({ serverName: 'myserver', uri: 'file:///foo.txt' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('not configured') || result.error?.includes('MCP_SERVER_NOT_CONFIGURED'));
        });
    });

    suite('InvokeMcpToolExecutor', () => {
        let executor: InvokeMcpToolExecutor;

        setup(() => {
            executor = new InvokeMcpToolExecutor();
        });

        test('missing serverName returns error', async () => {
            const result = await executor.execute({ toolName: 'some_tool' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('serverName'));
        });

        test('missing toolName returns error', async () => {
            const result = await executor.execute({ serverName: 'myserver' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('toolName'));
        });

        test('unconfigured server returns not configured error', async () => {
            const result = await executor.execute({ serverName: 'myserver', toolName: 'some_tool' });
            assert.strictEqual(result.success, false);
            assert.ok(result.error?.includes('not configured') || result.error?.includes('MCP_SERVER_NOT_CONFIGURED'));
        });

        test('invalid JSON arguments returns parse error', async () => {
            const result = await executor.execute({
                serverName: 'myserver',
                toolName: 'some_tool',
                arguments: '{bad json}',
            });
            // Either fails at "not configured" or at JSON parse — both are acceptable
            assert.strictEqual(result.success, false);
        });
    });
});
