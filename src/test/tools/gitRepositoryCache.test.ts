import * as assert from 'assert';
import { refreshGitRepositoryState } from '../../tools/gitRepositoryCache';

suite('gitRepositoryCache — refreshGitRepositoryState', () => {
    test('awaits repo.status() when present', async () => {
        let called = false;
        const repo = {
            status: async () => { called = true; },
        };
        await refreshGitRepositoryState(repo);
        assert.strictEqual(called, true);
    });

    test('does not throw when repo.status is absent (e.g. a minimal test stub)', async () => {
        const repo = {};
        await assert.doesNotReject(() => refreshGitRepositoryState(repo));
    });

    test('does not throw when repo.status() rejects — callers fall back to cached state', async () => {
        const repo = {
            status: async () => { throw new Error('git status failed'); },
        };
        await assert.doesNotReject(() => refreshGitRepositoryState(repo));
    });

    test('does not throw for a null/undefined repo', async () => {
        await assert.doesNotReject(() => refreshGitRepositoryState(null));
        await assert.doesNotReject(() => refreshGitRepositoryState(undefined));
    });
});
