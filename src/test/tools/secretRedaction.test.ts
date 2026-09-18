import * as assert from 'assert';
import { redactSecrets, containsSecrets, redactArgs, isSensitiveEnvName } from '../../tools/secretRedaction';

suite('SecretRedaction Tests', () => {

    suite('redactSecrets — known patterns', () => {
        test('redacts AWS access keys', () => {
            const { text, redactionCount } = redactSecrets('key=AKIAIOSFODNN7EXAMPLE');
            assert.ok(text.includes('[REDACTED]'), `Expected [REDACTED] in: ${text}`);
            assert.ok(redactionCount >= 1);
        });

        test('redacts private keys', () => {
            const input = '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAQQg...\n-----END RSA PRIVATE KEY-----';
            const { text, redactionCount } = redactSecrets(input);
            assert.ok(text.includes('[REDACTED]'));
            assert.ok(redactionCount >= 1);
        });

        test('redacts bearer tokens', () => {
            const { text, redactionCount } = redactSecrets('Authorization: bearer abc123def456ghi789jkl012mno345');
            assert.ok(text.includes('[REDACTED]'));
            assert.ok(redactionCount >= 1);
        });

        test('redacts JWTs', () => {
            const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
            const { text, redactionCount } = redactSecrets(jwt);
            assert.ok(text.includes('[REDACTED]'));
            assert.ok(redactionCount >= 1);
        });

        test('redacts GitHub tokens', () => {
            const { text, redactionCount } = redactSecrets('token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh');
            assert.ok(text.includes('[REDACTED]'));
            assert.ok(redactionCount >= 1);
        });

        test('redacts Slack tokens', () => {
            const { text, redactionCount } = redactSecrets('xoxb-123456789012-1234567890123-ABCDEFGHIJKLMNOPqrstuv');
            assert.ok(text.includes('[REDACTED]'));
            assert.ok(redactionCount >= 1);
        });

        test('redacts generic API keys', () => {
            const { text, redactionCount } = redactSecrets('api_key="abcdefghijklmnop12345678"');
            assert.ok(text.includes('[REDACTED]'));
            assert.ok(redactionCount >= 1);
        });

        test('returns original text when no secrets', () => {
            const input = 'This is a normal sentence with no secrets.';
            const { text, redactionCount } = redactSecrets(input);
            // Text may be modified by entropy detection, but redactionCount should be 0 for clean text
            assert.strictEqual(redactionCount, 0);
        });
    });

    suite('containsSecrets', () => {
        test('detects AWS key pattern', () => {
            assert.strictEqual(containsSecrets('AKIAIOSFODNN7EXAMPLE'), true);
        });

        test('detects GitHub token pattern', () => {
            assert.strictEqual(containsSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh'), true);
        });

        test('returns false for clean text', () => {
            assert.strictEqual(containsSecrets('Hello world, this is safe text.'), false);
        });

        test('returns false for short strings', () => {
            assert.strictEqual(containsSecrets('abc123'), false);
        });
    });

    suite('redactArgs', () => {
        test('redacts secrets in string values', () => {
            const { args, redactionCount } = redactArgs({
                command: 'echo AKIAIOSFODNN7EXAMPLE',
                path: '/safe/path',
            });
            assert.ok((args.command as string).includes('[REDACTED]'));
            assert.strictEqual(args.path, '/safe/path');
            assert.ok(redactionCount >= 1);
        });

        test('leaves non-string values untouched', () => {
            const { args, redactionCount } = redactArgs({
                count: 42,
                enabled: true,
                name: 'test',
            });
            assert.strictEqual(args.count, 42);
            assert.strictEqual(args.enabled, true);
            assert.strictEqual(args.name, 'test');
            assert.strictEqual(redactionCount, 0);
        });

        test('handles empty args', () => {
            const { args, redactionCount } = redactArgs({});
            assert.deepStrictEqual(args, {});
            assert.strictEqual(redactionCount, 0);
        });
    });

    suite('isSensitiveEnvName', () => {
        test('detects TOKEN pattern', () => {
            assert.strictEqual(isSensitiveEnvName('AUTH_TOKEN'), true);
            assert.strictEqual(isSensitiveEnvName('access_token'), true);
        });

        test('detects PASSWORD pattern', () => {
            assert.strictEqual(isSensitiveEnvName('DB_PASSWORD'), true);
        });

        test('detects SECRET pattern', () => {
            assert.strictEqual(isSensitiveEnvName('APP_SECRET'), true);
        });

        test('detects API_KEY pattern', () => {
            assert.strictEqual(isSensitiveEnvName('OPENAI_API_KEY'), true);
        });

        test('detects PRIVATE_KEY pattern', () => {
            assert.strictEqual(isSensitiveEnvName('SSH_PRIVATE_KEY'), true);
        });

        test('detects CREDENTIAL pattern', () => {
            assert.strictEqual(isSensitiveEnvName('AWS_CREDENTIAL_FILE'), true);
        });

        test('detects AUTH pattern', () => {
            assert.strictEqual(isSensitiveEnvName('AUTH_HEADER'), true);
        });

        test('returns false for safe env names', () => {
            assert.strictEqual(isSensitiveEnvName('HOME'), false);
            assert.strictEqual(isSensitiveEnvName('PATH'), false);
            assert.strictEqual(isSensitiveEnvName('EDITOR'), false);
            assert.strictEqual(isSensitiveEnvName('NODE_ENV'), false);
        });
    });
});
