/** Shared tool definitions for LLM function calling. */

export interface ToolDefinition {
    name: string;
    description: string;
    /** Legacy risk level (kept for backward compatibility). */
    riskLevel: 'safe' | 'moderate' | 'dangerous';
    /** PRD risk class (R0-R5). */
    riskClass: 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
    /** Which phase this tool belongs to. */
    phase: number;
    parameters: {
        type: 'object';
        // `items.properties` is optional — required for array-of-object
        // params (e.g. apply_multi_edit's `edits`), absent for array-of-
        // primitive params (e.g. stat_path's `paths: string[]`).
        properties: Record<string, { type: string; description?: string; items?: { type: string; properties?: Record<string, { type: string; description?: string; enum?: string[] }>; required?: string[] }; enum?: string[] }>;
        required?: string[];
    };
}

import { toolRegistry } from './toolRegistry';
import { ToolExecutor } from './toolExecutor';
import { ListDirExecutor } from './executors/listDir';
import { ReadFileExecutor } from './executors/readFile';
import { ApplyPatchExecutor } from './executors/applyPatch';
import { SearchFilesExecutor } from './executors/searchFiles';
import { ExecuteCommandExecutor } from './executors/executeCommand';
import { ExecuteInTerminalExecutor } from './executors/executeInTerminal';
import { GetWorkspaceInfoExecutor } from './executors/getWorkspaceInfo';
import { StatPathExecutor } from './executors/statPath';
import { GlobFilesExecutor } from './executors/globFiles';
import { AskUserQuestionExecutor } from './executors/askUserQuestion';
import { WriteFileExecutor } from './executors/writeFile';
import { EditFileExecutor } from './executors/editFile';
import { ApplyMultiEditExecutor } from './executors/applyMultiEdit';
import { GetDiagnosticsExecutor } from './executors/getDiagnostics';
import { GetEditorContextExecutor } from './executors/getEditorContext';
import { LspQueryExecutor } from './executors/lspQuery';
import { FormatDocumentExecutor } from './executors/formatDocument';
import { GetCodeActionsExecutor } from './executors/getCodeActions';
import { ApplyCodeActionExecutor } from './executors/applyCodeAction';
import { StartProcessExecutor } from './executors/startProcess';
import { ReadProcessOutputExecutor } from './executors/readProcessOutput';
import { WriteProcessInputExecutor } from './executors/writeProcessInput';
import { ListProcessesExecutor } from './executors/listProcesses';
import { StopProcessExecutor } from './executors/stopProcess';
import { WaitForProcessExecutor } from './executors/waitForProcess';
import { GitStatusExecutor } from './executors/gitStatus';
import { GitDiffExecutor } from './executors/gitDiff';
import { GitLogExecutor } from './executors/gitLog';
import { GitShowExecutor } from './executors/gitShow';
import { GitBlameExecutor } from './executors/gitBlame';
import { GitBranchExecutor } from './executors/gitBranch';
import { GitStageExecutor } from './executors/gitStage';
import { GitUnstageExecutor } from './executors/gitUnstage';
import { GitCommitExecutor } from './executors/gitCommit';
import { GitRestoreExecutor } from './executors/gitRestore';
import { CreateCheckpointExecutor } from './executors/createCheckpoint';
import { ListCheckpointsExecutor } from './executors/listCheckpoints';
import { RestoreCheckpointExecutor } from './executors/restoreCheckpoint';
import { GetProjectProfileExecutor } from './executors/getProjectProfile';
import { RunBuildExecutor } from './executors/runBuild';
import { RunLintExecutor } from './executors/runLint';
import { RunTestsExecutor } from './executors/runTests';
import { GetRuntimeInfoExecutor } from './executors/getRuntimeInfo';
import { ListEnvNamesExecutor } from './executors/listEnvNames';
import { ReadEnvValueExecutor } from './executors/readEnvValue';
import { CreateTaskExecutor, UpdateTaskExecutor, ListTasksExecutor, GetTaskExecutor, WriteNoteExecutor, ReadNoteExecutor, SendNotificationExecutor } from './executors/taskTools';

// Phase 5: Web tools (implemented) + Debug tools
import { WebSearchExecutor } from './executors/webSearch';
import { WebFetchExecutor } from './executors/webFetch';
import { GetDebugSessionsExecutor, GetCallStackExecutor, GetDebugScopesExecutor, EvaluateDebugExpressionExecutor, GetBreakpointsExecutor, StartDebuggingExecutor, StopDebuggingExecutor } from './executors/debugTools';

// Phase 6: Multi-Agent / Extensibility
import { ReadMemoryExecutor, WriteMemoryExecutor, DeleteMemoryExecutor } from './executors/memoryTools';
import { ListSkillsExecutor, LoadSkillExecutor } from './executors/skillTools';
import { SpawnAgentExecutor, SendAgentMessageExecutor, GetAgentStatusExecutor, WaitForAgentExecutor, StopAgentExecutor } from './executors/agentOrchestrator';
import { SearchToolsExecutor, LoadToolExecutor, ListMcpResourcesExecutor, ReadMcpResourceExecutor, InvokeMcpToolExecutor } from './executors/mcpTools';

/** Feature flags for tools not yet ready for general use. */
export const featureFlags = {
    /** Enable multi-agent subagent tools (P3-T1). Default: true. */
    multiAgentEnabled: true,
    /** Enable MCP transport tools (P3-T2). Default: false. */
    mcpEnabled: false,
};

// Register all tools at import time
function registerTools(commandBlocklist?: string[]) {
    const tools: Array<{ def: ToolDefinition; executor: ToolExecutor }> = [
        // --- Phase 1: Workspace / Filesystem / Search ---
        {
            def: {
                name: 'get_workspace_info',
                description: 'Return workspace roots, trust state, platform info, repository roots, and high-level project metadata.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        includeProjectHints: { type: 'boolean', description: 'Include detected project types.' },
                        includeRepositoryRoots: { type: 'boolean', description: 'Include Git repository roots.' },
                    },
                },
            },
            executor: new GetWorkspaceInfoExecutor(),
        },
        {
            def: {
                name: 'list_dir',
                description: 'List files and directories at a path relative to the workspace root.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative directory path, use "." for workspace root.' },
                    },
                    required: ['path'],
                },
            },
            executor: new ListDirExecutor(),
        },
        {
            def: {
                name: 'stat_path',
                description: 'Return metadata for a file, directory, symlink, or missing path — size, mtime, permissions, content hash, and line count for files under 1MB — without returning file contents. Use this instead of read_file when you only need a file\'s size or line count, not its content. To stat many paths (e.g. every file in a directory) in one call instead of one call per file, pass `paths` (an array) instead of `path`.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file or directory path. Use this for a single path.' },
                        paths: { type: 'array', items: { type: 'string' }, description: 'Multiple workspace-relative paths to stat in one call (max 500). Returns an array of results in the same order. Use this instead of `path` + repeated calls when checking many files.' },
                        followSymlink: { type: 'boolean', description: 'Follow symlinks (default: false).' },
                    },
                },
            },
            executor: new StatPathExecutor(),
        },
        {
            def: {
                name: 'read_file',
                description: 'Read a UTF-8 text file relative to the workspace root. Supports line ranges and byte limits.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/file.ts". Never use absolute paths.' },
                        startLine: { type: 'integer', description: '0-based start line (optional).' },
                        endLine: { type: 'integer', description: '0-based end line (optional).' },
                        maxBytes: { type: 'integer', description: 'Maximum bytes to read (optional).' },
                    },
                    required: ['path'],
                },
            },
            executor: new ReadFileExecutor(),
        },
        {
            def: {
                name: 'glob_files',
                description: 'Discover files by glob pattern, e.g. "**/*.ts" or "src/**/test_*.py".',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        patterns: { type: 'string', description: 'Glob pattern or comma-separated patterns.' },
                        basePath: { type: 'string', description: 'Base directory to search from (default: workspace root).' },
                        excludePatterns: { type: 'string', description: 'Comma-separated exclude patterns.' },
                        maxResults: { type: 'integer', description: 'Maximum number of results (default: 100).' },
                    },
                    required: ['patterns'],
                },
            },
            executor: new GlobFilesExecutor(),
        },
        {
            def: {
                name: 'search_files',
                description: 'Search for a regex pattern across files in a directory.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative directory path.' },
                        pattern: { type: 'string', description: 'Regex pattern.' },
                        filePattern: { type: 'string', description: 'Optional glob filter.' },
                        maxResults: { type: 'integer', description: 'Maximum number of results (default: 100).' },
                    },
                    required: ['path', 'pattern'],
                },
            },
            executor: new SearchFilesExecutor(),
        },
        // --- Phase 1: File mutation ---
        {
            def: {
                name: 'edit_file',
                description: 'Perform a precise text replacement in one file using exact oldText → newText. Requires exactly one match unless replaceAll is true.',
                riskLevel: 'moderate',
                riskClass: 'R1',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/file.ts". Never use absolute paths.' },
                        oldText: { type: 'string', description: 'Exact text to replace (must match uniquely).' },
                        newText: { type: 'string', description: 'Replacement text.' },
                        replaceAll: { type: 'boolean', description: 'Replace all occurrences (default: false).' },
                        expectedVersion: { type: 'string', description: 'Expected file version hash from last read.' },
                    },
                    required: ['path', 'oldText', 'newText'],
                },
            },
            executor: new EditFileExecutor(),
        },
        {
            def: {
                name: 'write_file',
                description: 'Create a new file or replace the entire contents of an existing file. Overwrites by default — use edit_file for precise targeted replacements instead.',
                riskLevel: 'moderate',
                riskClass: 'R1',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/file.ts". Never use absolute paths.' },
                        content: { type: 'string', description: 'Full file contents.' },
                        overwrite: { type: 'boolean', description: 'Overwrite existing file (default: false).' },
                        expectedVersion: { type: 'string', description: 'Expected version when overwriting.' },
                    },
                    required: ['path', 'content'],
                },
            },
            executor: new WriteFileExecutor(),
        },
        {
            def: {
                name: 'apply_patch',
                description: 'Apply a change to a file by providing its full new content. Generates a diff. Use edit_file for precise targeted replacements instead.',
                riskLevel: 'moderate',
                riskClass: 'R1',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/file.ts". Never use absolute paths.' },
                        content: { type: 'string', description: 'Full new file contents.' },
                        expectedVersion: { type: 'string', description: 'Expected file version hash from last read.' },
                    },
                    required: ['path', 'content'],
                },
            },
            executor: new ApplyPatchExecutor(),
        },
        {
            def: {
                name: 'apply_multi_edit',
                description: 'Apply multiple file edits atomically in a single transaction. All edits are validated first (fail fast), then applied via WorkspaceEdit for full undo support. Supports create, edit, and delete modes. Max 20 edits per transaction.',
                riskLevel: 'dangerous',
                riskClass: 'R2',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        edits: {
                            type: 'array',
                            description: 'Array of FileEdit objects. Each has: path (string, workspace-relative), mode ("create"|"edit"|"delete"), newContent (string, for create), oldText (string, for edit), newText (string, for edit), expectedVersion (string, optional stale guard).',
                            items: {
                                type: 'object',
                                properties: {
                                    path: { type: 'string', description: 'Workspace-relative file path.' },
                                    mode: { type: 'string', enum: ['create', 'edit', 'delete'], description: 'Edit mode.' },
                                    newContent: { type: 'string', description: 'Full content for new files (mode: create).' },
                                    oldText: { type: 'string', description: 'Exact text to replace (mode: edit).' },
                                    newText: { type: 'string', description: 'Replacement text (mode: edit).' },
                                    expectedVersion: { type: 'string', description: 'Expected content hash for stale check.' },
                                },
                                required: ['path', 'mode'],
                            },
                        },
                    },
                    required: ['edits'],
                },
            },
            executor: new ApplyMultiEditExecutor(),
        },
        // --- Phase 1: Editor context & diagnostics ---
        {
            def: {
                name: 'get_editor_context',
                description: 'Return VS Code-native context: active editor, selections, visible ranges, open editors, and dirty state.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        includeSelections: { type: 'boolean', description: 'Include cursor selections.' },
                        includeOpenEditors: { type: 'boolean', description: 'Include list of open editors.' },
                        includeVisibleRanges: { type: 'boolean', description: 'Include visible line ranges.' },
                    },
                },
            },
            executor: new GetEditorContextExecutor(),
        },
        {
            def: {
                name: 'get_diagnostics',
                description: 'Return VS Code diagnostics (errors, warnings) for a file, folder, or the entire workspace.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file or folder path (omit for workspace-wide).' },
                        severity: { type: 'string', description: 'Filter by severity: error, warning, info, hint.' },
                        maxResults: { type: 'integer', description: 'Maximum number of results (default: 50).' },
                    },
                },
            },
            executor: new GetDiagnosticsExecutor(),
        },
        // --- Phase 1: Human interaction ---
        {
            def: {
                name: 'ask_user_question',
                description: 'Ask the user a structured clarification or choice question. Use this instead of asking conversational questions in text when you need the user to pick between options, confirm a direction, or make a decision that blocks further work. Renders an inline card with clickable options in the chat panel.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        question: { type: 'string', description: 'The question to ask.' },
                        options: { type: 'string', description: 'JSON array of {label, description} objects.' },
                        multiSelect: { type: 'boolean', description: 'Allow multiple selections (default: false).' },
                    },
                    required: ['question'],
                },
            },
            executor: new AskUserQuestionExecutor(),
        },
        // --- Phase 1+: Shell ---
        {
            def: {
                name: 'execute_command',
                description: 'Execute a CLI command in the workspace directory. Requires user approval.',
                riskLevel: 'dangerous',
                riskClass: 'R2',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'The CLI command.' },
                        timeout: { type: 'integer', description: 'Timeout in seconds (default 30, max 300).' },
                    },
                    required: ['command'],
                },
            },
            executor: new ExecuteCommandExecutor(commandBlocklist),
        },
        {
            def: {
                name: 'execute_in_terminal',
                description: 'Execute a shell command in a persistent VS Code terminal named "CodeOn". Use for long-running or interactive processes where you want the user to see output in real-time. The terminal persists across tool calls.',
                riskLevel: 'moderate',
                riskClass: 'R2',
                phase: 1,
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'The shell command to execute.' },
                        reveal: { type: 'boolean', description: 'Reveal the terminal panel (default: true).' },
                    },
                    required: ['command'],
                },
            },
            executor: new ExecuteInTerminalExecutor(),
        },
        // --- Phase 2: Code Intelligence ---
        {
            def: {
                name: 'lsp_query',
                description: 'Perform language-server operations: definition, references, hover, symbols, rename preview, etc.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 2,
                parameters: {
                    type: 'object',
                    properties: {
                        operation: { type: 'string', description: 'Operation: document_symbols, workspace_symbols, definition, references, hover, rename_preview, etc.' },
                        path: { type: 'string', description: 'Workspace-relative file path (required for most operations).' },
                        position: { type: 'string', description: 'JSON {line, character} for cursor-position operations.' },
                        query: { type: 'string', description: 'Symbol search query for *_symbols operations.' },
                        maxResults: { type: 'integer', description: 'Maximum results (default: 50).' },
                    },
                    required: ['operation'],
                },
            },
            executor: new LspQueryExecutor(),
        },
        {
            def: {
                name: 'format_document',
                description: 'Format a full document or selected range using the configured VS Code formatter.',
                riskLevel: 'moderate',
                riskClass: 'R1',
                phase: 2,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/file.ts". Never use absolute paths.' },
                        startLine: { type: 'integer', description: 'Start line for range format (optional).' },
                        endLine: { type: 'integer', description: 'End line for range format (optional).' },
                        previewOnly: { type: 'boolean', description: 'Preview only, do not apply (default: false).' },
                    },
                    required: ['path'],
                },
            },
            executor: new FormatDocumentExecutor(),
        },
        {
            def: {
                name: 'get_code_actions',
                description: 'List available quick fixes, refactors, and source actions for a file range or diagnostic.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 2,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/file.ts". Never use absolute paths.' },
                        startLine: { type: 'integer', description: 'Start line of range.' },
                        endLine: { type: 'integer', description: 'End line of range.' },
                        kind: { type: 'string', description: 'Filter by action kind (quickfix, refactor, source).' },
                    },
                    required: ['path'],
                },
            },
            executor: new GetCodeActionsExecutor(),
        },
        {
            def: {
                name: 'apply_code_action',
                description: 'Apply a previously retrieved code action by its index.',
                riskLevel: 'moderate',
                riskClass: 'R1',
                phase: 2,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/file.ts". Never use absolute paths.' },
                        actionIndex: { type: 'integer', description: 'Index of action from get_code_actions result.' },
                        startLine: { type: 'integer', description: 'Start line of range used to retrieve actions.' },
                        endLine: { type: 'integer', description: 'End line of range used to retrieve actions.' },
                        previewOnly: { type: 'boolean', description: 'Preview only (default: false).' },
                    },
                    required: ['path', 'actionIndex'],
                },
            },
            executor: new ApplyCodeActionExecutor(),
        },
        // --- Phase 2: Build / Lint / Test ---
        {
            def: {
                name: 'get_project_profile',
                description: 'Detect project type and return build/lint/test/format commands based on configuration files found in the workspace.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 2,
                parameters: {
                    type: 'object',
                    properties: {
                        refresh: { type: 'boolean', description: 'Force refresh detection (default: false).' },
                    },
                },
            },
            executor: new GetProjectProfileExecutor(),
        },
        {
            def: {
                name: 'run_build',
                description: 'Execute the project build command (auto-detected from profile or explicit).',
                riskLevel: 'moderate',
                riskClass: 'R1',
                phase: 2,
                parameters: {
                    type: 'object',
                    properties: {
                        profile: { type: 'string', description: 'Explicit build command. Auto-detected if omitted.' },
                        timeout: { type: 'integer', description: 'Timeout in seconds (default: 120, max: 600).' },
                    },
                },
            },
            executor: new RunBuildExecutor(),
        },
        {
            def: {
                name: 'run_lint',
                description: 'Execute the project lint command (auto-detected from profile). Optionally auto-fix.',
                riskLevel: 'moderate',
                riskClass: 'R1',
                phase: 2,
                parameters: {
                    type: 'object',
                    properties: {
                        files: { type: 'string', description: 'Comma-separated list of files to lint.' },
                        fix: { type: 'boolean', description: 'Auto-fix lint issues where supported.' },
                        timeout: { type: 'integer', description: 'Timeout in seconds (default: 60, max: 300).' },
                    },
                },
            },
            executor: new RunLintExecutor(),
        },
        {
            def: {
                name: 'run_tests',
                description: 'Execute the project test suite (auto-detected framework). Supports file/name filters and coverage.',
                riskLevel: 'moderate',
                riskClass: 'R1',
                phase: 2,
                parameters: {
                    type: 'object',
                    properties: {
                        file: { type: 'string', description: 'Filter tests by file path or pattern.' },
                        name: { type: 'string', description: 'Filter tests by test name.' },
                        coverage: { type: 'boolean', description: 'Run with coverage enabled.' },
                        timeout: { type: 'integer', description: 'Timeout in seconds (default: 120, max: 600).' },
                    },
                },
            },
            executor: new RunTestsExecutor(),
        },
        // --- Phase 3: Process Management ---
        {
            def: {
                name: 'start_process',
                description: 'Start a long-running background process. The process is tracked in a global registry and can be managed with other Phase 3 tools (read output, write input, stop, wait).',
                riskLevel: 'dangerous',
                riskClass: 'R2',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', description: 'The command to execute (shell command string).' },
                        cwd: { type: 'string', description: 'Working directory relative to workspace root (default: workspace root).' },
                        name: { type: 'string', description: 'Optional display name for the process.' },
                    },
                    required: ['command'],
                },
            },
            executor: new StartProcessExecutor(),
        },
        {
            def: {
                name: 'read_process_output',
                description: 'Read recent output from a managed background process. Supports stdout, stderr, or both streams with configurable line limits.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        processId: { type: 'string', description: 'ID of the managed process (returned by start_process).' },
                        maxLines: { type: 'integer', description: 'Maximum number of recent lines to return (default: 50).' },
                        stream: { type: 'string', description: 'Which stream to read: stdout, stderr, or both (default: both).' },
                    },
                    required: ['processId'],
                },
            },
            executor: new ReadProcessOutputExecutor(),
        },
        {
            def: {
                name: 'write_process_input',
                description: 'Send text to stdin of an interactive managed process. A newline is appended automatically if not present.',
                riskLevel: 'dangerous',
                riskClass: 'R2',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        processId: { type: 'string', description: 'ID of the managed process.' },
                        text: { type: 'string', description: 'Text to send to stdin.' },
                    },
                    required: ['processId', 'text'],
                },
            },
            executor: new WriteProcessInputExecutor(),
        },
        {
            def: {
                name: 'list_processes',
                description: 'List all managed background processes with their status, command, PID, start time, and uptime.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {},
                },
            },
            executor: new ListProcessesExecutor(),
        },
        {
            def: {
                name: 'stop_process',
                description: 'Stop a managed background process gracefully. Sends SIGTERM first, then SIGKILL after a configurable grace period if still running.',
                riskLevel: 'dangerous',
                riskClass: 'R2',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        processId: { type: 'string', description: 'ID of the managed process to stop.' },
                        gracePeriodMs: { type: 'integer', description: 'Milliseconds to wait between SIGTERM and SIGKILL (default: 3000, max: 30000).' },
                    },
                    required: ['processId'],
                },
            },
            executor: new StopProcessExecutor(),
        },
        {
            def: {
                name: 'wait_for_process',
                description: 'Wait for a managed process to exit or for its output to match a regex pattern. Returns immediately if already exited.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        processId: { type: 'string', description: 'ID of the managed process to wait for.' },
                        pattern: { type: 'string', description: 'Optional regex pattern to match against combined stdout/stderr output.' },
                        timeoutMs: { type: 'integer', description: 'Maximum wait time in milliseconds (default: 30000, max: 120000).' },
                    },
                    required: ['processId'],
                },
            },
            executor: new WaitForProcessExecutor(),
        },
        // --- Phase 3: Runtime / Environment ---
        {
            def: {
                name: 'get_runtime_info',
                description: 'Return OS/arch/runtime versions, available language servers, and detected project types.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        categories: { type: 'string', description: 'Comma-separated categories: runtimes, languageservers, profiles.' },
                    },
                },
            },
            executor: new GetRuntimeInfoExecutor(),
        },
        {
            def: {
                name: 'list_env_names',
                description: 'List environment variable names with sensitivity classification (no values returned).',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', description: 'Scope: process, shell, or system.' },
                        nameFilter: { type: 'string', description: 'Filter by substring match on name.' },
                    },
                },
            },
            executor: new ListEnvNamesExecutor(),
        },
        {
            def: {
                name: 'read_env_value',
                description: 'Read a specific environment variable value. Sensitive values require approval.',
                riskLevel: 'moderate',
                riskClass: 'R1',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Environment variable name (exact, no wildcards).' },
                        destination: { type: 'string', description: 'Destination: tool or model. Default: tool.' },
                    },
                    required: ['name'],
                },
            },
            executor: new ReadEnvValueExecutor(),
        },
        // --- Phase 3: Task State ---
        {
            def: {
                name: 'create_task',
                description: 'Create a new tracking task.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Task title.' },
                        description: { type: 'string', description: 'Task description.' },
                        agentId: { type: 'string', description: 'Agent ID owning this task.' },
                        fileScope: { type: 'string', description: 'Comma-separated file paths in scope.' },
                    },
                    required: ['title'],
                },
            },
            executor: new CreateTaskExecutor(),
        },
        {
            def: {
                name: 'update_task',
                description: 'Update task status, progress, or blocker.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Task ID.' },
                        status: { type: 'string', description: 'New status: pending, in_progress, completed, blocked.' },
                        progress: { type: 'string', description: 'Progress note.' },
                        blocker: { type: 'string', description: 'Blocker description.' },
                    },
                    required: ['id'],
                },
            },
            executor: new UpdateTaskExecutor(),
        },
        {
            def: {
                name: 'list_tasks',
                description: 'List tasks with optional status or agent filter.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        status: { type: 'string', description: 'Filter by status.' },
                        agentId: { type: 'string', description: 'Filter by agent ID.' },
                    },
                },
            },
            executor: new ListTasksExecutor(),
        },
        {
            def: {
                name: 'get_task',
                description: 'Get details of a specific task by ID.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Task ID.' },
                    },
                    required: ['id'],
                },
            },
            executor: new GetTaskExecutor(),
        },
        {
            def: {
                name: 'write_note',
                description: 'Write a key-value scratchpad note.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        key: { type: 'string', description: 'Note key.' },
                        value: { type: 'string', description: 'Note value.' },
                        scope: { type: 'string', description: 'Scope: session or workspace.' },
                    },
                    required: ['key', 'value'],
                },
            },
            executor: new WriteNoteExecutor(),
        },
        {
            def: {
                name: 'read_note',
                description: 'Read a scratchpad note by key, or list all notes.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        key: { type: 'string', description: 'Note key (omit to list all).' },
                        scope: { type: 'string', description: 'Filter by scope when listing.' },
                    },
                },
            },
            executor: new ReadNoteExecutor(),
        },
        {
            def: {
                name: 'send_notification',
                description: 'Send a VS Code notification to the user.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 3,
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Notification title.' },
                        message: { type: 'string', description: 'Notification message.' },
                        severity: { type: 'string', description: 'Severity: info, warning, error.' },
                    },
                    required: ['title', 'message'],
                },
            },
            executor: new SendNotificationExecutor(),
        },
        // --- Phase 4: Git & Source Control ---
        {
            def: {
                name: 'git_status',
                description: 'Return Git repository status: current branch, ahead/behind counts, and categorized file states (staged, unstaged, untracked, conflicted).',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {},
                },
            },
            executor: new GitStatusExecutor(),
        },
        {
            def: {
                name: 'git_diff',
                description: 'Return a unified diff for staged or unstaged changes. Supports filtering by file path and byte limit.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        mode: { type: 'string', description: 'Diff mode: staged, unstaged, or HEAD (default: unstaged).' },
                        path: { type: 'string', description: 'Workspace-relative file path to diff (omit for all files).' },
                        maxBytes: { type: 'integer', description: 'Maximum bytes to return (default: 1000000).' },
                    },
                },
            },
            executor: new GitDiffExecutor(),
        },
        {
            def: {
                name: 'git_log',
                description: 'Return recent commit history with optional filters for path, author, and result limit.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        limit: { type: 'integer', description: 'Maximum number of commits (default: 20, max: 500).' },
                        path: { type: 'string', description: 'Workspace-relative file path to filter commits.' },
                        author: { type: 'string', description: 'Author name or email substring to filter by.' },
                    },
                },
            },
            executor: new GitLogExecutor(),
        },
        {
            def: {
                name: 'git_show',
                description: 'Show details of a commit, tag, or file version at a given revision (hash, branch, tag, etc.).',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        revision: { type: 'string', description: 'Git revision: commit hash, branch name, tag, HEAD, etc. (default: HEAD).' },
                        path: { type: 'string', description: 'Workspace-relative file path to show at this revision.' },
                    },
                },
            },
            executor: new GitShowExecutor(),
        },
        {
            def: {
                name: 'git_blame',
                description: 'Return line-level attribution (blame) for a file, showing which commit last modified each line.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/file.ts". Never use absolute paths.' },
                        startLine: { type: 'integer', description: '1-based start line (optional).' },
                        endLine: { type: 'integer', description: '1-based end line (optional).' },
                    },
                    required: ['path'],
                },
            },
            executor: new GitBlameExecutor(),
        },
        {
            def: {
                name: 'git_branch',
                description: 'List, create, switch, or delete Git branches. Uses VS Code Git API where possible.',
                riskLevel: 'moderate',
                riskClass: 'R2',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        operation: { type: 'string', description: 'Operation: list, create, switch, or delete (default: list).' },
                        branch: { type: 'string', description: 'Branch name (required for create, switch, delete).' },
                        startPoint: { type: 'string', description: 'Start point for new branch (default: current HEAD).' },
                    },
                    required: ['operation'],
                },
            },
            executor: new GitBranchExecutor(),
        },
        {
            def: {
                name: 'git_stage',
                description: 'Stage one or more file paths for the next commit using VS Code Git API.',
                riskLevel: 'moderate',
                riskClass: 'R2',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        paths: { type: 'string', description: 'JSON array of workspace-relative file paths to stage.' },
                    },
                    required: ['paths'],
                },
            },
            executor: new GitStageExecutor(),
        },
        {
            def: {
                name: 'git_unstage',
                description: 'Unstage one or more file paths from the index using VS Code Git API.',
                riskLevel: 'moderate',
                riskClass: 'R2',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        paths: { type: 'string', description: 'JSON array of workspace-relative file paths to unstage.' },
                    },
                    required: ['paths'],
                },
            },
            executor: new GitUnstageExecutor(),
        },
        {
            def: {
                name: 'git_commit',
                description: 'Create a local Git commit from currently staged changes. Optionally adds DCO sign-off.',
                riskLevel: 'dangerous',
                riskClass: 'R3',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        message: { type: 'string', description: 'Commit message.' },
                        signoff: { type: 'boolean', description: 'Add Signed-off-by trailer (default: false).' },
                    },
                    required: ['message'],
                },
            },
            executor: new GitCommitExecutor(),
        },
        {
            def: {
                name: 'git_restore',
                description: 'Restore working tree or staged content to a given source (HEAD or staging). Supports dry-run.',
                riskLevel: 'dangerous',
                riskClass: 'R3',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        paths: { type: 'string', description: 'JSON array of workspace-relative file paths to restore.' },
                        source: { type: 'string', description: 'Source: HEAD or staging (default: HEAD).' },
                        target: { type: 'string', description: 'Target: workingtree or staged (default: workingtree).' },
                        dryRun: { type: 'boolean', description: 'Preview without applying (default: false).' },
                    },
                    required: ['paths'],
                },
            },
            executor: new GitRestoreExecutor(),
        },
        // --- Phase 4: Checkpoints ---
        {
            def: {
                name: 'create_checkpoint',
                description: 'Create a recoverable snapshot of specified files. Stores original content in .codeon/checkpoints/ for later restoration.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        label: { type: 'string', description: 'Human-readable label for the checkpoint.' },
                        paths: { type: 'string', description: 'JSON array of workspace-relative file paths to snapshot.' },
                    },
                    required: ['paths'],
                },
            },
            executor: new CreateCheckpointExecutor(),
        },
        {
            def: {
                name: 'list_checkpoints',
                description: 'List all available checkpoints with metadata (id, label, creation time, files).',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {},
                },
            },
            executor: new ListCheckpointsExecutor(),
        },
        {
            def: {
                name: 'restore_checkpoint',
                description: 'Restore files to their state at a given checkpoint. Supports dry-run preview.',
                riskLevel: 'moderate',
                riskClass: 'R2',
                phase: 4,
                parameters: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Checkpoint ID to restore from.' },
                        dryRun: { type: 'boolean', description: 'Preview what would be restored without applying (default: false).' },
                    },
                    required: ['id'],
                },
            },
            executor: new RestoreCheckpointExecutor(),
        },
        // ------------------------------------------------------------------
        // Phase 5: Web tools (web_fetch enabled, web_search disabled) + Browser / Debugging (stubs)
        // ------------------------------------------------------------------
        // web_search remains disabled until a reliable no-API-key search backend
        // is available (e.g., SearXNG). web_fetch is enabled — it works natively
        // with no API key needed (just fetches whatever URL you give it).
        //
        // { disabled: web_search — see above }
        {
            def: {
                name: 'web_fetch',
                description: 'Fetch a URL and return its content as text. Supports content negotiation (prefers markdown), automatic HTML-to-text conversion, redirect following (max 5), and SSRF protection against private/reserved IPs.',
                riskLevel: 'safe',
                riskClass: 'R0',
                phase: 5,
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'The URL to fetch (http:// or https:// only).' },
                        format: { type: 'string', description: 'Preferred output format: markdown, html, or text (default: markdown).' },
                    },
                    required: ['url'],
                },
            },
            executor: new WebFetchExecutor(),
        },
        // Browser tools removed (P0-T2) — will be re-added with real Playwright implementation in P3-T3.
        { def: { name: 'get_debug_sessions', description: 'List active debug sessions with name, type, and state.', riskLevel: 'safe', riskClass: 'R0', phase: 5, parameters: { type: 'object', properties: {} } }, executor: new GetDebugSessionsExecutor() },
        { def: { name: 'get_call_stack', description: 'Get call stack for a debug thread, including file paths, line numbers, and function names.', riskLevel: 'safe', riskClass: 'R0', phase: 5, parameters: { type: 'object', properties: { sessionId: { type: 'integer' }, threadId: { type: 'integer' } } } }, executor: new GetCallStackExecutor() },
        { def: { name: 'get_debug_scopes', description: 'Get variable scopes (Locals, Arguments, Closure, etc.) for a stack frame in the active debug session.', riskLevel: 'safe', riskClass: 'R0', phase: 5, parameters: { type: 'object', properties: { sessionId: { type: 'integer' }, frameId: { type: 'integer' } } } }, executor: new GetDebugScopesExecutor() },
        { def: { name: 'evaluate_debug_expression', description: 'Evaluate an expression in the context of the active debug session, optionally scoped to a specific stack frame.', riskLevel: 'moderate', riskClass: 'R1', phase: 5, parameters: { type: 'object', properties: { expression: { type: 'string' }, sessionId: { type: 'integer' }, frameId: { type: 'integer' } }, required: ['expression'] } }, executor: new EvaluateDebugExpressionExecutor() },
        { def: { name: 'get_breakpoints', description: 'List all breakpoints, optionally filtered by file path.', riskLevel: 'safe', riskClass: 'R0', phase: 5, parameters: { type: 'object', properties: { path: { type: 'string' } } } }, executor: new GetBreakpointsExecutor() },
        { def: { name: 'start_debugging', description: 'Start a debug session using a launch configuration (JSON or config name).', riskLevel: 'moderate', riskClass: 'R2', phase: 5, parameters: { type: 'object', properties: { config: { type: 'string' } } } }, executor: new StartDebuggingExecutor() },
        { def: { name: 'stop_debugging', description: 'Stop debugging — either a specific session by ID or the active session.', riskLevel: 'moderate', riskClass: 'R2', phase: 5, parameters: { type: 'object', properties: { sessionId: { type: 'integer' } } } }, executor: new StopDebuggingExecutor() },
        // ------------------------------------------------------------------
        // Phase 6: Multi-Agent / Extensibility
        // ------------------------------------------------------------------
        // Search/load tool — always available (read-only introspection)
        { def: { name: 'search_tools', description: 'Search available tools by keyword. Matches against tool names and descriptions with relevance scoring.', riskLevel: 'safe' as const, riskClass: 'R0' as const, phase: 6, parameters: { type: 'object' as const, properties: { query: { type: 'string', description: 'Search query (space-separated keywords).' } }, required: ['query'] } }, executor: new SearchToolsExecutor() },
        { def: { name: 'load_tool', description: 'Look up a tool definition by name. Returns full schema, description, and risk metadata. Read-only operation.', riskLevel: 'moderate' as const, riskClass: 'R2' as const, phase: 6, parameters: { type: 'object' as const, properties: { toolName: { type: 'string', description: 'Registered tool name to look up.' } }, required: ['toolName'] } }, executor: new LoadToolExecutor() },
        { def: { name: 'list_skills', description: 'List available skills discovered in .codeon/skills/ directories within the workspace or extension.', riskLevel: 'safe' as const, riskClass: 'R0' as const, phase: 6, parameters: { type: 'object' as const, properties: {} } }, executor: new ListSkillsExecutor() },
        { def: { name: 'load_skill', description: 'Load a skill definition by name from .codeon/skills/ directories. Returns the skill content and source file path.', riskLevel: 'safe' as const, riskClass: 'R0' as const, phase: 6, parameters: { type: 'object' as const, properties: { skillName: { type: 'string', description: 'Skill directory name to load.' } }, required: ['skillName'] } }, executor: new LoadSkillExecutor() },
        { def: { name: 'read_memory', description: 'Read persistent key-value memory entries. Optionally filter by key and scope (user or workspace). Lists all entries when no key is provided.', riskLevel: 'safe' as const, riskClass: 'R0' as const, phase: 6, parameters: { type: 'object' as const, properties: { key: { type: 'string', description: 'Memory key to read (omit to list all).' }, scope: { type: 'string', description: 'Scope: user or workspace (default: workspace).' } } } }, executor: new ReadMemoryExecutor() },
        { def: { name: 'write_memory', description: 'Write or update a persistent key-value memory entry. Rejects values containing detected secrets.', riskLevel: 'moderate' as const, riskClass: 'R1' as const, phase: 6, parameters: { type: 'object' as const, properties: { key: { type: 'string', description: 'Memory key.' }, value: { type: 'string', description: 'Memory value.' }, scope: { type: 'string', description: 'Scope: user or workspace (default: workspace).' } }, required: ['key', 'value'] } }, executor: new WriteMemoryExecutor() },
        { def: { name: 'delete_memory', description: 'Delete a persistent memory entry by key.', riskLevel: 'moderate' as const, riskClass: 'R2' as const, phase: 6, parameters: { type: 'object' as const, properties: { key: { type: 'string', description: 'Memory key to delete.' }, scope: { type: 'string', description: 'Scope: user or workspace (default: workspace).' } }, required: ['key'] } }, executor: new DeleteMemoryExecutor() },
    ];

    // Multi-agent tools — guarded behind feature flag (enabled in P3-T1)
    if (featureFlags.multiAgentEnabled) {
        tools.push(
            { def: { name: 'spawn_agent', description: 'Spawn an independent LLM-powered sub-agent to run a task in parallel. Use this when a task has multiple independent sub-tasks that can run concurrently — for example, analyzing different modules, searching across unrelated directories, or reviewing multiple files at once. Each sub-agent gets its own conversation loop with a restricted tool allowlist. After spawning, use wait_for_agent to collect results.', riskLevel: 'moderate', riskClass: 'R2', phase: 6, parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Task prompt for the subagent. Be specific about what to analyze and what format to return results in.' }, toolAllowlist: { type: 'string', description: 'Comma-separated list of allowed tool names (e.g. read_file,glob_files,search_files,lsp_query). Only give the tools the sub-agent actually needs.' }, worktree: { type: 'string', description: 'Optional git worktree path for isolation.' }, maxTurns: { type: 'integer', description: 'Override the auto-computed turn budget (default scales with toolAllowlist size, ~10-40). Raise this for tasks over large directories or many files — the default is sized for a small tool count, not task size, so a well-scoped agent pointed at a big directory can otherwise run out of turns before finishing.' }, timeoutMs: { type: 'integer', description: 'Override the auto-computed wall-clock timeout in milliseconds (default scales with toolAllowlist size, ~120000-600000, capped at 600000). Raise this alongside maxTurns for the same large-task reason. Max 1800000 (30 min).' } }, required: ['prompt'] } }, executor: new SpawnAgentExecutor() },
            { def: { name: 'send_agent_message', description: 'Send a message to a running subagent to influence its ongoing work.', riskLevel: 'safe', riskClass: 'R0', phase: 6, parameters: { type: 'object', properties: { agentId: { type: 'string', description: 'ID of the target subagent.' }, message: { type: 'string', description: 'Message content to send.' } }, required: ['agentId', 'message'] } }, executor: new SendAgentMessageExecutor() },
            { def: { name: 'get_agent_status', description: 'Get the current status, progress, and tool usage statistics of a subagent.', riskLevel: 'safe', riskClass: 'R0', phase: 6, parameters: { type: 'object', properties: { agentId: { type: 'string', description: 'ID of the target subagent.' } }, required: ['agentId'] } }, executor: new GetAgentStatusExecutor() },
            { def: { name: 'wait_for_agent', description: 'Wait for a subagent to finish its task and return results. Call this after spawn_agent to collect the output before proceeding. Blocks until the agent completes, errors, or times out.', riskLevel: 'safe', riskClass: 'R0', phase: 6, parameters: { type: 'object', properties: { agentId: { type: 'string', description: 'ID of the target subagent.' }, timeoutMs: { type: 'integer', description: 'Maximum wait time in milliseconds (default: 600000).' } }, required: ['agentId'] } }, executor: new WaitForAgentExecutor() },
            { def: { name: 'stop_agent', description: 'Stop a running subagent gracefully. Sets status to stopped and cleans up resources.', riskLevel: 'moderate', riskClass: 'R2', phase: 6, parameters: { type: 'object', properties: { agentId: { type: 'string', description: 'ID of the target subagent.' } }, required: ['agentId'] } }, executor: new StopAgentExecutor() },
        );
    }

    // MCP transport tools — guarded behind feature flag (enabled in P3-T2)
    if (featureFlags.mcpEnabled) {
        tools.push(
            { def: { name: 'list_mcp_resources', description: 'List configured MCP servers and their advertised resources. Returns helpful guidance when no servers are configured.', riskLevel: 'safe', riskClass: 'R0', phase: 6, parameters: { type: 'object', properties: { serverName: { type: 'string', description: 'Filter by specific server name (optional).' } } } }, executor: new ListMcpResourcesExecutor() },
            { def: { name: 'read_mcp_resource', description: 'Read a resource from an MCP server by its URI.', riskLevel: 'safe', riskClass: 'R0', phase: 6, parameters: { type: 'object', properties: { serverName: { type: 'string', description: 'Configured MCP server name.' }, uri: { type: 'string', description: 'Resource URI to read.' } }, required: ['serverName', 'uri'] } }, executor: new ReadMcpResourceExecutor() },
            { def: { name: 'invoke_mcp_tool', description: 'Invoke a tool on a configured MCP server with JSON arguments. Passes through policy evaluation before execution.', riskLevel: 'moderate', riskClass: 'R2', phase: 6, parameters: { type: 'object', properties: { serverName: { type: 'string', description: 'Configured MCP server name.' }, toolName: { type: 'string', description: 'Tool name on the MCP server.' }, arguments: { type: 'string', description: 'JSON-encoded arguments object.' } }, required: ['serverName', 'toolName'] } }, executor: new InvokeMcpToolExecutor() },
        );
    }

    for (const { def, executor } of tools) {
        toolRegistry.register(def, executor);
    }
}

// Public API to get tool definitions (for LLM function calling schema)
export function getToolDefinitions(): ToolDefinition[] {
    return toolRegistry.allDefinitions();
}

// Auto-initialize with defaults on import.
registerTools();

// Legacy export for backward compatibility with apiClient.ts
export const TOOL_DEFINITIONS: ToolDefinition[] = getToolDefinitions();
