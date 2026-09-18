import { ToolExecutor, ToolResult } from '../toolExecutor';
import { isSensitiveEnvName } from '../secretRedaction';

export class ListEnvNamesExecutor implements ToolExecutor {
    public name = 'list_env_names';

    public async execute(args: Record<string, unknown>): Promise<ToolResult> {
        try {
            const scope = args.scope ? String(args.scope) : 'process';
            const nameFilter = args.nameFilter ? String(args.nameFilter).toLowerCase() : '';

            // Get environment variables (names only, no values)
            const envVars = Object.entries(process.env)
                .filter(([key]) => !nameFilter || key.toLowerCase().includes(nameFilter))
                .map(([key]) => ({
                    name: key,
                    sensitive: isSensitiveEnvName(key),
                    hasValue: true,
                    source: scope,
                }));

            // Sort: non-sensitive first, then alphabetical
            envVars.sort((a, b) => {
                if (a.sensitive !== b.sensitive) return a.sensitive ? 1 : -1;
                return a.name.localeCompare(b.name);
            });

            return {
                success: true,
                output: JSON.stringify({
                    count: envVars.length,
                    variables: envVars,
                    warning: 'Values are not returned. Use read_env_value to access specific values.',
                }, null, 2),
            };
        } catch (e) {
            return { success: false, output: '', error: (e as Error).message };
        }
    }
}
