import { ChatCompletionMessage } from '../types';

// ------------------------------------------------------------------
// Structured summary shape
// ------------------------------------------------------------------

export interface StructuredSummary {
    filesModified: string[];   // "path: description of change"
    filesRead: string[];       // "path: what was found"
    toolResults: string[];     // "tool_name(args): outcome"
    errors: string[];          // "error message: resolution"
    decisions: string[];       // architecture/design decisions
    userIntent: string;        // what the user wanted
    inProgress: string[];      // what's currently in progress
    constraints: string[];     // user instructions/rules that must hold
    remainingWork: string[];   // tasks still to be done
    nextAction: string;        // most logical immediate next step
}

/** Empty / zero-state summary. */
const EMPTY_SUMMARY: StructuredSummary = {
    filesModified: [],
    filesRead: [],
    toolResults: [],
    errors: [],
    decisions: [],
    userIntent: '',
    inProgress: [],
    constraints: [],
    remainingWork: [],
    nextAction: '',
};

// ------------------------------------------------------------------
// Tool-name classification helpers
// ------------------------------------------------------------------

const FILE_WRITE_TOOLS = new Set([
    'write_file',
    'edit_file',
    'apply_patch',
    'notebook_edit',
]);

const FILE_READ_TOOLS = new Set([
    'read_file',
    'glob',
    'grep_search',
    'lsp_query',
    'list_directory',
]);

const COMMAND_TOOLS = new Set([
    'execute_command',
    'run_tests',
    'run_build',
]);

// Keywords that signal a decision or architectural discussion
const DECISION_KEYWORDS = [
    'decided to',
    'decision is',
    'we should',
    'we will use',
    'architecture',
    'design choice',
    'going with',
    'recommend',
    'I recommend',
    'the approach',
    'best approach',
];

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Analyze a list of conversation messages and extract a structured summary.
 * Walks through every message looking for file operations, tool results,
 * errors, decisions, and user intent — preserving exact paths and error text.
 */
export function analyzeMessages(messages: ChatCompletionMessage[]): StructuredSummary {
    if (messages.length === 0) return { ...EMPTY_SUMMARY };

    const summary: StructuredSummary = {
        filesModified: [],
        filesRead: [],
        toolResults: [],
        errors: [],
        decisions: [],
        userIntent: '',
        inProgress: [],
        constraints: [],
        remainingWork: [],
        nextAction: '',
    };

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // --- User messages → intent ---
        if (msg.role === 'user' && msg.content) {
            extractUserIntent(msg.content, summary);
        }

        // --- Assistant messages → decisions ---
        if (msg.role === 'assistant' && msg.content) {
            extractDecisions(msg.content, summary);

            // Check tool_calls on assistant messages
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    const args = parseToolArgs(tc.function.arguments);
                    classifyToolCall(tc.function.name, args, summary);
                }
            }
        }

        // --- Tool messages → results & errors ---
        if (msg.role === 'tool' && msg.content) {
            extractErrors(msg.content, summary);

            // Try to find which tool produced this result
            if (msg.tool_call_id) {
                const callingMsg = findCallingMessage(messages, i, msg.tool_call_id);
                if (callingMsg && callingMsg.tool_calls) {
                    for (const tc of callingMsg.tool_calls) {
                        if (tc.id === msg.tool_call_id) {
                            extractToolResult(tc.function.name, msg.content, summary);
                            break;
                        }
                    }
                }
            }
        }

        // --- In-progress signals from the last assistant message ---
        if (msg.role === 'assistant' && i === messages.length - 1 && msg.content) {
            extractInProgress(msg.content, summary);
        }
    }

    return summary;
}

/** Render a structured summary as markdown with clear sections. */
export function formatSummary(summary: StructuredSummary): string {
    const sections: string[] = [];

    sections.push('## Conversation Summary');

    if (summary.userIntent) {
        sections.push(`\n### User Intent\n${summary.userIntent}`);
    }

    if (summary.filesModified.length > 0) {
        sections.push('\n### Files Modified\n' + summary.filesModified.map(f => `- ${f}`).join('\n'));
    }

    if (summary.filesRead.length > 0) {
        sections.push('\n### Files Read\n' + summary.filesRead.map(f => `- ${f}`).join('\n'));
    }

    if (summary.toolResults.length > 0) {
        sections.push('\n### Tool Results\n' + summary.toolResults.map(t => `- ${t}`).join('\n'));
    }

    if (summary.errors.length > 0) {
        sections.push('\n### Errors Encountered\n' + summary.errors.map(e => `- ${e}`).join('\n'));
    }

    if (summary.decisions.length > 0) {
        sections.push('\n### Architecture Decisions\n' + summary.decisions.map(d => `- ${d}`).join('\n'));
    }

    if (summary.inProgress.length > 0) {
        sections.push('\n### Current State\n' + summary.inProgress.map(p => `- ${p}`).join('\n'));
    }

    if (summary.constraints.length > 0) {
        sections.push('\n### Constraints\n' + summary.constraints.map(c => `- ${c}`).join('\n'));
    }

    if (summary.remainingWork.length > 0) {
        sections.push('\n### Remaining Work\n' + summary.remainingWork.map(r => `- ${r}`).join('\n'));
    }

    if (summary.nextAction) {
        sections.push(`\n### Next Action\n${summary.nextAction}`);
    }

    return sections.join('\n');
}

// ------------------------------------------------------------------
// Extraction helpers
// ------------------------------------------------------------------

/** Parse JSON arguments from a tool call, falling back gracefully. */
function parseToolArgs(raw: string): Record<string, unknown> {
    try {
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** Find the assistant message that issued a given tool_call_id. */
function findCallingMessage(
    messages: ChatCompletionMessage[],
    toolMsgIndex: number,
    toolCallId: string,
): ChatCompletionMessage | undefined {
    for (let i = toolMsgIndex - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && m.tool_calls) {
            for (const tc of m.tool_calls) {
                if (tc.id === toolCallId) return m;
            }
        }
        // Stop at the first non-tool message before the tool result
        if (m.role !== 'tool') break;
    }
    return undefined;
}

/** Extract user intent from a user message. Keep it concise. */
function extractUserIntent(content: string, summary: StructuredSummary): void {
    // If we already captured intent, append briefly rather than replacing
    const trimmed = content.trim();
    if (!trimmed) return;

    // Take the first sentence or first ~200 chars as the intent
    let intent = trimmed;
    const sentenceEnd = intent.match(/[^.!?]{0,200}[.!?]/);
    if (sentenceEnd) {
        intent = sentenceEnd[0];
    } else if (intent.length > 200) {
        intent = intent.slice(0, 200) + '...';
    }

    if (summary.userIntent) {
        summary.userIntent += '; then: ' + intent;
    } else {
        summary.userIntent = intent;
    }
}

/** Classify a tool call by name and extract relevant info. */
function classifyToolCall(name: string, args: Record<string, unknown>, summary: StructuredSummary): void {
    const filePath = extractFilePath(args);

    if (FILE_WRITE_TOOLS.has(name) && filePath) {
        const desc = buildFileChangeDesc(name, args);
        summary.filesModified.push(`${filePath}: ${desc}`);
    } else if (FILE_READ_TOOLS.has(name) && filePath) {
        summary.filesRead.push(`${filePath}: read for context`);
    } else if (COMMAND_TOOLS.has(name)) {
        const cmdArg = typeof args.command === 'string' ? args.command : String(args.command ?? '');
        summary.toolResults.push(`${name}("${truncate(cmdArg, 80)}"): executed`);
    }
}

/** Build a short description of what a file-editing tool did. */
function buildFileChangeDesc(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
        case 'write_file':
            return 'created or overwrote file';
        case 'edit_file': {
            const oldLen = typeof args.old_string === 'string' ? args.old_string.split('\n').length : 0;
            return `edited ~${oldLen} lines`;
        }
        case 'apply_patch':
            return 'applied patch';
        case 'notebook_edit':
            return 'edited notebook cell';
        default:
            return 'modified';
    }
}

/** Extract a file path from tool arguments. */
function extractFilePath(args: Record<string, unknown>): string | undefined {
    const candidates: (keyof typeof args)[] = ['file_path', 'filePath', 'file', 'path', 'directory'];
    for (const key of candidates) {
        if (typeof args[key] === 'string' && args[key]) return args[key] as string;
    }
    return undefined;
}

/** Extract tool execution results from a tool response message. */
function extractToolResult(toolName: string, content: string, summary: StructuredSummary): void {
    // Only add if not already tracked by classifyToolCall (which adds "executed")
    const existing = summary.toolResults.find(t => t.startsWith(toolName));
    if (existing) return; // Already has a placeholder; keep it simple

    const truncated = truncate(content, 120);
    summary.toolResults.push(`${toolName}(): ${truncated}`);
}

/** Extract error information from tool output. */
function extractErrors(content: string, summary: StructuredSummary): void {
    const lower = content.toLowerCase();
    if (!lower.includes('error') && !lower.includes('failed') && !lower.includes('exception')) return;

    // Try to pull out the actual error message
    const errorMatch = content.match(
        /(?:Error|ERROR|Exception|Failed|FAILED)[^:]*:[\s]*["']?([^"\n]+)["']?/i,
    );

    if (errorMatch) {
        const errorMsg = errorMatch[1].trim();
        // Check if there's a resolution nearby (look for "fixed", "resolved", "solution")
        const resolutionMatch = content.match(
            /(?:fixed|resolved|solution|fix|corrected)[^:]*:[\s]*["']?([^"\n]+)["']?/i,
        );
        const resolution = resolutionMatch ? resolutionMatch[1].trim() : 'pending';

        summary.errors.push(`"${errorMsg}": ${resolution}`);
    } else {
        // Fallback: quote the first line containing an error keyword
        const lines = content.split('\n');
        for (const line of lines) {
            if (/error|failed|exception/i.test(line)) {
                const cleanLine = line.trim().slice(0, 150);
                summary.errors.push(`"${cleanLine}": pending`);
                break;
            }
        }
    }
}

/** Extract architecture/design decisions from assistant messages. */
function extractDecisions(content: string, summary: StructuredSummary): void {
    const lower = content.toLowerCase();
    for (const keyword of DECISION_KEYWORDS) {
        const idx = lower.indexOf(keyword);
        if (idx >= 0) {
            // Extract the sentence containing the keyword
            const beforeDot = content.slice(idx).match(/[^.!?]{0,250}[.!?]?/);
            if (beforeDot) {
                const sentence = beforeDot[0].trim();
                // Avoid duplicates
                if (!summary.decisions.some(d => d.toLowerCase().includes(sentence.toLowerCase().slice(0, 50)))) {
                    summary.decisions.push(sentence);
                }
            }
            break; // One decision per message is enough
        }
    }
}

/** Extract "in progress" items from the last assistant message. */
function extractInProgress(content: string, summary: StructuredSummary): void {
    const patterns = [
        /next (?:I'll|I will|we'll|we will) ([^.!?\n]+)/i,
        /(?:still|currently) (?:working on|implementing|doing) ([^.!?\n]+)/i,
        /(?:TODO|FIXME|HACK)[^\n]*?([\w\s]+)/i,
    ];

    for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match) {
            const item = match[1].trim();
            if (item && item.length > 3) {
                summary.inProgress.push(item);
            }
        }
    }
}

/** Truncate a string to a max length, appending ellipsis if needed. */
function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...';
}
