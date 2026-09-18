import * as assert from 'assert';
import {
    extractChangedFiles,
    formatVerification,
    clearProjectCache,
    VerificationResult,
} from '../../conversation/verificationMiddleware';

suite('VerificationMiddleware - extractChangedFiles', () => {
    test('extracts file from edit_file args', () => {
        const files = extractChangedFiles('edit_file', { file: 'src/foo.ts' });
        assert.deepStrictEqual(files, ['src/foo.ts']);
    });

    test('extracts filePath from write_file args', () => {
        const files = extractChangedFiles('write_file', { filePath: 'src/bar.ts' });
        assert.deepStrictEqual(files, ['src/bar.ts']);
    });

    test('extracts path from apply_patch args', () => {
        const files = extractChangedFiles('apply_patch', { path: 'lib/util.js' });
        assert.deepStrictEqual(files, ['lib/util.js']);
    });

    test('returns empty for non-modifying tools', () => {
        const files = extractChangedFiles('read_file', { file: 'src/foo.ts' });
        assert.deepStrictEqual(files, []);
    });

    test('returns empty for unknown tool', () => {
        const files = extractChangedFiles('unknown_tool', { file: 'src/foo.ts' });
        assert.deepStrictEqual(files, []);
    });

    test('handles file_path key variant', () => {
        const files = extractChangedFiles('edit_file', { file_path: 'deep/nested/file.py' });
        assert.deepStrictEqual(files, ['deep/nested/file.py']);
    });

    test('handles missing file arg gracefully', () => {
        const files = extractChangedFiles('edit_file', {});
        assert.deepStrictEqual(files, []);
    });
});

suite('VerificationMiddleware - formatVerification', () => {
    test('formats skipped result', () => {
        const result: VerificationResult = {
            steps: [],
            overall: 'skipped',
            files: [],
            totalDurationMs: 0,
        };
        const text = formatVerification(result);
        assert.ok(text.includes('VERIFICATION SKIPPED'));
    });

    test('formats passed result with steps', () => {
        const result: VerificationResult = {
            steps: [
                { name: 'diagnostics', passed: true, output: '  No issues found', durationMs: 5 },
                { name: 'typecheck', passed: true, output: '', durationMs: 1200 },
            ],
            overall: 'passed',
            files: ['src/foo.ts'],
            totalDurationMs: 1210,
        };
        const text = formatVerification(result);
        assert.ok(text.includes('[VERIFICATION PASSED]'));
        assert.ok(text.includes('✓ diagnostics'));
        assert.ok(text.includes('✓ typecheck'));
        assert.ok(text.includes('src/foo.ts'));
    });

    test('formats failed result with failure details', () => {
        const result: VerificationResult = {
            steps: [
                { name: 'diagnostics', passed: false, output: '  src/foo.ts:42 [error] Cannot find name x', durationMs: 3 },
                { name: 'lint', passed: true, output: '', durationMs: 800 },
            ],
            overall: 'failed',
            files: ['src/foo.ts'],
            totalDurationMs: 807,
        };
        const text = formatVerification(result);
        assert.ok(text.includes('[VERIFICATION FAILED]'));
        assert.ok(text.includes('✗ diagnostics'));
        assert.ok(text.includes('Cannot find name x'));
    });

    test('includes duration in output', () => {
        const result: VerificationResult = {
            steps: [{ name: 'lint', passed: true, output: '', durationMs: 500 }],
            overall: 'passed',
            files: ['a.ts'],
            totalDurationMs: 500,
        };
        const text = formatVerification(result);
        assert.ok(text.includes('500ms'));
    });
});

suite('VerificationMiddleware - project cache', () => {
    setup(() => {
        clearProjectCache();
    });

    teardown(() => {
        clearProjectCache();
    });

    test('clearProjectCache resets cache', () => {
        // Just verify the function exists and is callable without error
        clearProjectCache();
        assert.ok(true);
    });
});
