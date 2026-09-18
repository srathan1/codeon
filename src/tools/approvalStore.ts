import * as fs from 'fs';
import * as path from 'path';

/**
 * Workspace-level approval rules persisted to .codeon/approval-rules.json.
 * A rule auto-approves tool calls matching its criteria, bypassing the
 * approval threshold dialog.
 */
export interface ApprovalRule {
    /** Unique identifier (timestamp-based). */
    id: string;
    /** Tool name to auto-approve, or '*' for all tools at this risk level. */
    toolName: string;
    /** Risk class to auto-approve (e.g., 'R3', 'dangerous'). */
    riskLevel: string;
    /** When the rule was created. */
    createdAt: string;
}

/** Raw JSON stored on disk. */
interface ApprovalRulesFile {
    rules: ApprovalRule[];
}

const RULES_FILE = '.codeon/approval-rules.json';

/** In-memory singleton per workspace. */
let _workspaceRoot: string | null = null;
let _rules: ApprovalRule[] = [];
let _loaded = false;
/**
 * M-14: mtime of the rules file as of our last read/write. Used to detect
 * edits made to the file outside this process (e.g. hand-editing
 * .codeon/approval-rules.json, or another workspace window sharing the
 * same folder) — previously `_loaded` only reset when the workspace root
 * itself changed, so same-session external edits were invisible until
 * restart.
 */
let _lastKnownMtimeMs: number | null = null;

/**
 * Initialize the approval store for a workspace.
 * Call once during extension activation with the workspace root path.
 * Idempotent — safe to call multiple times with the same root.
 */
export function initApprovalStore(workspaceRoot: string): void {
    // Avoid resetting the cache if already initialized for this workspace
    if (_workspaceRoot === workspaceRoot) return;
    _workspaceRoot = workspaceRoot;
    _loaded = false;
    _lastKnownMtimeMs = null;
}

/**
 * Load rules from disk. Called lazily on first read/write, and re-reads
 * whenever the on-disk file's mtime no longer matches what we last saw
 * (M-14) — picking up external edits without requiring a restart.
 */
function loadRules(): ApprovalRule[] {
    if (!_workspaceRoot) {
        return _rules;
    }

    const filePath = path.join(_workspaceRoot, RULES_FILE);

    if (_loaded) {
        try {
            const mtimeMs = fs.statSync(filePath).mtimeMs;
            if (mtimeMs === _lastKnownMtimeMs) {
                return _rules;
            }
            // mtime changed since our last read — fall through and reload.
        } catch {
            // File no longer exists on disk; keep serving the in-memory rules.
            return _rules;
        }
    }
    _loaded = true;

    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw) as ApprovalRulesFile;
            _rules = parsed.rules || [];
            _lastKnownMtimeMs = fs.statSync(filePath).mtimeMs;
        }
    } catch {
        // If file is corrupt or unreadable, start fresh
        _rules = [];
    }

    return _rules;
}

/**
 * Persist current rules to disk.
 */
function saveRules(): void {
    if (!_workspaceRoot) return;

    const dir = path.dirname(path.join(_workspaceRoot, RULES_FILE));
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const filePath = path.join(_workspaceRoot, RULES_FILE);
    fs.writeFileSync(filePath, JSON.stringify({ rules: _rules }, null, 2), 'utf8');
    // Record the mtime post-write so our own save doesn't look like an
    // external edit on the next loadRules() call.
    try {
        _lastKnownMtimeMs = fs.statSync(filePath).mtimeMs;
    } catch {
        _lastKnownMtimeMs = null;
    }
}

/**
 * Check if a tool call should be auto-approved based on workspace rules.
 */
export function isAutoApproved(toolName: string, riskLevel: string): boolean {
    const rules = loadRules();
    return rules.some(rule =>
        (rule.toolName === '*' || rule.toolName === toolName) &&
        rule.riskLevel === riskLevel
    );
}

/**
 * Add a new auto-approval rule and persist to disk.
 */
export function addRule(toolName: string, riskLevel: string): ApprovalRule {
    loadRules();

    const rule: ApprovalRule = {
        id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        toolName,
        riskLevel,
        createdAt: new Date().toISOString(),
    };

    // Avoid duplicates
    const exists = _rules.some(r =>
        r.toolName === rule.toolName && r.riskLevel === rule.riskLevel
    );

    if (!exists) {
        _rules.push(rule);
        saveRules();
    }

    return rule;
}

/**
 * Remove a rule by ID.
 */
export function removeRule(id: string): boolean {
    loadRules();
    const index = _rules.findIndex(r => r.id === id);
    if (index >= 0) {
        _rules.splice(index, 1);
        saveRules();
        return true;
    }
    return false;
}

/**
 * Get all current rules.
 */
export function getRules(): ApprovalRule[] {
    return [...loadRules()];
}

/**
 * Reset the store (for tests).
 */
export function resetApprovalStore(): void {
    _workspaceRoot = null;
    _rules = [];
    _loaded = false;
    _lastKnownMtimeMs = null;
}
