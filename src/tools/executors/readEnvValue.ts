import * as vscode from 'vscode';
import { ToolExecutor, ToolResult } from '../toolExecutor';
import { isSensitiveEnvName } from '../secretRedaction';

export class ReadEnvValueExecutor implements ToolExecutor {
    public name = 'read_env_value';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const envName = args.name ? String(args.name) : '';
            const destination = args.destination ? String(args.destination) : 'tool';

            if (!envName) {
                return { success: false, output: '', error: 'Missing required parameter: name' };
            }

            // Block wildcard reads
            if (envName.includes('*') || envName.includes(',')) {
                return { success: false, output: '', error: 'SECRET_ACCESS_DENIED: wildcard reads are not allowed' };
            }

            const value = process.env[envName];
            if (value === undefined) {
                return { success: false, output: '', error: `Environment variable '${envName}' not found` };
            }

            const sensitive = isSensitiveEnvName(envName);

            // If sensitive and destination is model context, redact
            if (sensitive && destination !== 'tool') {
                return {
                    success: true,
                    output: JSON.stringify({
                        name: envName,
                        sensitive: true,
                        value: '[REDACTED — use secure handle injection instead]',
                        length: value.length,
                        warning: 'Sensitive value redacted. Use this value only in tool execution, not in model context.',
                    }, null, 2),
                };
            }

            // Ask for user confirmation for sensitive values
            if (sensitive) {
                const confirmed = await vscode.window.showWarningMessage(
                    `Access environment variable '${envName}'?`,
                    { modal: true },
                    'Allow'
                );
                if (!confirmed) {
                    return { success: false, output: '', error: 'User denied access to sensitive environment variable' };
                }
            }

            return {
                success: true,
                output: JSON.stringify({
                    name: envName,
                    sensitive,
                    value,
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
