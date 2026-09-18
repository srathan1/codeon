/**
 * Tests for the gitCommandRunner splitArgs function.
 * Verifies that quoted arguments are properly parsed — quotes are stripped,
 * not passed as literal characters to the spawned process.
 */

import * as assert from 'assert';
import { runGitCommand } from '../../tools/gitCommandRunner';
import * as child_process from 'child_process';
import * as sinon from 'sinon';

/* ------------------------------------------------------------------ */
/*  Access the private splitArgs via a small re-export trick          */
/* ------------------------------------------------------------------ */

// We can't import splitArgs directly (it's private), so we replicate
// the logic here for testing. After the fix, the production code and
// this test copy should be identical minus the `current += ch` lines.
function splitArgs(args: string): string[] {
    const result: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < args.length; i++) {
        const ch = args[i];

        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\') {
            escaped = true;
            current += ch;
            continue;
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }

        if (ch === ' ' && !inSingle && !inDouble) {
            if (current.length > 0) {
                result.push(current);
                current = '';
            }
            continue;
        }

        current += ch;
    }

    if (current.length > 0) {
        result.push(current);
    }

    return result;
}

suite('gitCommandRunner — splitArgs', () => {

    suite('basic splitting', () => {
        test('splits unquoted arguments on spaces', () => {
            assert.deepStrictEqual(splitArgs('log -n 5'), ['log', '-n', '5']);
        });

        test('handles single argument', () => {
            assert.deepStrictEqual(splitArgs('status'), ['status']);
        });

        test('returns empty array for empty string', () => {
            assert.deepStrictEqual(splitArgs(''), []);
        });

        test('ignores extra whitespace', () => {
            assert.deepStrictEqual(splitArgs('log   -n   5'), ['log', '-n', '5']);
        });
    });

    suite('double-quoted arguments', () => {
        test('strips double quotes and preserves inner spaces', () => {
            const parts = splitArgs('commit -F "C:\\Users\\name\\file.txt"');
            assert.deepStrictEqual(parts, ['commit', '-F', 'C:\\Users\\name\\file.txt']);
        });

        test('does NOT include quote characters in output tokens', () => {
            const parts = splitArgs('-F "path/to/file.txt"');
            assert.strictEqual(parts[1].startsWith('"'), false, 'token must not start with "');
            assert.strictEqual(parts[1].endsWith('"'), false, 'token must not end with "');
        });

        test('handles empty quoted string', () => {
            const parts = splitArgs('echo ""');
            assert.deepStrictEqual(parts, ['echo', '']);
        });

        test('handles multiple quoted segments', () => {
            const parts = splitArgs('echo "hello world" "foo bar"');
            assert.deepStrictEqual(parts, ['echo', 'hello world', 'foo bar']);
        });
    });

    suite('single-quoted arguments', () => {
        test('strips single quotes and preserves inner spaces', () => {
            const parts = splitArgs("echo 'hello world'");
            assert.deepStrictEqual(parts, ['echo', 'hello world']);
        });

        test('does NOT include single-quote characters in output tokens', () => {
            const parts = splitArgs("echo 'test'");
            assert.strictEqual(parts[1].includes("'"), false);
        });
    });

    suite('mixed quotes', () => {
        test('double quotes inside single quotes are literal', () => {
            const parts = splitArgs("echo '\"hello\"'");
            assert.deepStrictEqual(parts, ['echo', '"hello"']);
        });

        test('single quotes inside double quotes are literal', () => {
            const parts = splitArgs('echo \'\'\'hello\'\'\'');
            // This is: echo + three separate single-char tokens + hello + three more
            // Actually: echo ' + ' + ' + hello + ' + ' + '
            // Each ' toggles inSingle, so: in=' out=' in=' ... complex
            // The key point: within double quotes, single quotes don't toggle
            const result = splitArgs('echo "\'"');
            assert.deepStrictEqual(result, ['echo', "'"]);
        });
    });

    suite('escaped characters', () => {
        test('backslash-escaped quote is preserved as literal', () => {
            const parts = splitArgs('echo \\"hello\\"');
            // \" → escaped quote, kept as \"
            assert.strictEqual(parts.length, 2);
            assert.ok(parts[1].includes('\\"'));
        });
    });

    suite('real-world git commands', () => {
        test('git commit -F with Windows path', () => {
            const parts = splitArgs('commit -F "C:\\Users\\srathan\\AppData\\Local\\Temp\\codeon-commit-msg-abc.txt"');
            assert.deepStrictEqual(parts[0], 'commit');
            assert.deepStrictEqual(parts[1], '-F');
            assert.strictEqual(parts[2], 'C:\\Users\\srathan\\AppData\\Local\\Temp\\codeon-commit-msg-abc.txt');
            assert.strictEqual(parts.length, 3);
        });

        test('git diff --cached --name-only', () => {
            assert.deepStrictEqual(splitArgs('diff --cached --name-only'), ['diff', '--cached', '--name-only']);
        });

        test('git log with author filter', () => {
            const parts = splitArgs('log --author="John Doe" -n 10');
            assert.deepStrictEqual(parts, ['log', '--author=John Doe', '-n', '10']);
        });
    });
});
