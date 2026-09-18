import { ParsedToolCall } from '../types';

/**
 * Normalize tool arguments after JSON parsing.
 * Some models send array/object parameters as JSON-encoded strings
 * (e.g., paths: "[\"a.ts\", \"b.ts\"]" instead of paths: ["a.ts", "b.ts"]).
 * This function detects & decodes those values so executors receive clean data.
 */
function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string') {
            // Try to decode JSON-encoded strings that look like arrays or objects
            if ((value.startsWith('[') && value.length > 1) || (value.startsWith('{') && value.length > 1)) {
                try {
                    const parsed = JSON.parse(value);
                    if (Array.isArray(parsed) || typeof parsed === 'object') {
                        result[key] = parsed;
                        continue;
                    }
                } catch {
                    // Not valid JSON, keep original string
                }
            }
            // Also handle strings that have escaped newlines (common with multi-line content)
            // e.g., "{\"path\":\"...\",\"content\":\"...\"}" — these are already handled above
            result[key] = value;
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Parse tool calls from LLM responses.
 * Supports two formats:
 * 1. Native OpenAI-compatible structured tool calls (from SSE or JSON)
 * 2. Qwen-style in-content markers (\u200b\u001d...\u001c\u200b) as fallback
 */
export function parseToolCalls(
    content: string,
    nativeToolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
): ParsedToolCall[] {
    const results: ParsedToolCall[] = [];

    if (nativeToolCalls?.length) {
        for (const tc of nativeToolCalls) {
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(tc.function.arguments);
                args = normalizeArgs(args);
            } catch {
                args = {};
            }
            results.push({
                id: tc.id,
                name: tc.function.name,
                arguments: args,
                raw: tc.function.arguments
            });
        }
    }

    // Fallback: scan for Qwen-style in-content markers
    const qwenPattern = /\u200b\u001d(.*?)\u001c\u200b/g;
    let qwenIndex = 0;
    for (const match of content.matchAll(qwenPattern)) {
        const inner = match[1].trim();
        let name: string | undefined;
        let args: Record<string, unknown> = {};

        const nameMatch = inner.match(/<name>\s*(.*?)\s*<\/name>/);
        const argsMatch = inner.match(/<arguments>\s*(.*?)\s*<\/arguments>/s);
        if (nameMatch) {
            name = nameMatch[1].trim();
        }
        if (argsMatch?.[1]?.trim()) {
            try {
                args = JSON.parse(argsMatch[1].trim());
                args = normalizeArgs(args);
            } catch {
                args = {};
            }
        }
        if (!name) {
            try {
                const obj = JSON.parse(inner) as { name?: string; arguments?: Record<string, unknown> };
                name = obj.name;
                args = normalizeArgs(obj.arguments || {});
            } catch {
                // ignore malformed tool block
            }
        }
        if (name) {
            results.push({
                id: `qwen_${qwenIndex++}`,
                name,
                arguments: args,
                raw: inner
            });
        }
    }

    return results;
}
