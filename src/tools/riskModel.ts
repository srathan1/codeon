/**
 * Risk classification system (PRD §7).
 * 6-level risk classes evaluated per invocation, not only per tool.
 */

/** Risk class names matching PRD terminology. */
export type RiskClass = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

/** Human-readable descriptions for each risk class. */
export const RISK_DESCRIPTIONS: Record<RiskClass, string> = {
    R0: 'Local read-only',
    R1: 'Bounded local mutation',
    R2: 'Local execution',
    R3: 'Destructive or history-changing',
    R4: 'Secret-bearing or external',
    R5: 'High-impact',
};

/** Numeric ordering for comparison (higher = more risky). */
export const RISK_ORDER: Record<RiskClass, number> = {
    R0: 0, R1: 1, R2: 2, R3: 3, R4: 4, R5: 5,
};

/** Default policy decision per risk class. */
export const DEFAULT_POLICY: Record<RiskClass, 'allow' | 'require_approval' | 'deny'> = {
    R0: 'allow',
    R1: 'require_approval',
    R2: 'require_approval',
    R3: 'require_approval',
    R4: 'require_approval',
    R5: 'deny',
};

/**
 * Legacy risk level mapping to new risk classes.
 * Used during migration from the old 3-tier system.
 *
 * M-10: 'moderate' previously mapped to 'R1', but every registered tool in
 * toolDefinitions.ts that carries riskLevel:'moderate' and an explicit
 * riskClass pairs it with 'R2' (8 of 10 such tools), not 'R1' — this fallback
 * is only exercised for a tool registered without an explicit riskClass, and
 * should match that dominant convention rather than silently under-classify it.
 */
export function legacyRiskToClass(level: 'safe' | 'moderate' | 'dangerous'): RiskClass {
    switch (level) {
        case 'safe': return 'R0';
        case 'moderate': return 'R2';
        case 'dangerous': return 'R3';
    }
}

/**
 * Evaluate the risk class of a tool invocation based on the tool's base risk
 * and invocation-specific factors.
 */
export interface RiskFactors {
    /** Base risk class of the tool definition. */
    baseRisk: RiskClass;
    /** Whether the operation targets a protected/sensitive path. */
    targetsProtectedPath?: boolean;
    /** Whether the operation is destructive (delete, force overwrite, etc.). */
    isDestructive?: boolean;
    /** Whether the operation accesses secrets or credentials. */
    accessesSecrets?: boolean;
    /** Whether the operation has external visibility (network, browser, etc.). */
    hasExternalVisibility?: boolean;
    /** Whether the operation modifies Git history. */
    modifiesHistory?: boolean;
    /**
     * Whether the operation targets the extension's own audit log or approval-rules
     * store (.codeon/). Unlike targetsProtectedPath (which escalates to an
     * approvable R3), this escalates to R5 and is denied unconditionally — see
     * policyEngine.evaluate()'s isDenied() check, which runs before approval is
     * even consulted. Approving a write here would let the model tamper with the
     * record of its own actions (P5-T3).
     */
    targetsAuditTrail?: boolean;
    /** Number of files affected (for escalation heuristics). */
    fileCount?: number;
    /** Command string for execute_command risk evaluation. */
    command?: string;
}

/**
 * Destructive command patterns that escalate risk. P5-T11: covers short flags
 * (-r/-rf/-fr), long flags (--recursive --force), and common cross-language
 * recursive-delete equivalents, since the model can express the same
 * destructive intent in any of these forms. This list can never be exhaustive;
 * the goal is to catch the obvious spellings that the short-flag-only regex
 * previously missed (e.g. `rm --recursive --force /`, `shutil.rmtree(...)`).
 */
const DESTRUCTIVE_PATTERNS = [
    /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r|-rf|-fr)/i, // rm with combined short flags incl. -Rf etc.
    /rm\s+.*--recursive/i,
    /rm\s+.*--force/i,
    /\brmdir\s+\/s/i,                    // Windows rmdir /s
    /\brd\s+\/s/i,                       // Windows rd /s
    /remove-item\b.*-recurse/i,          // PowerShell Remove-Item -Recurse
    /\bshutil\.rmtree\s*\(/i,            // Python
    /\bos\.remove\s*\(/i,                // Python single-file remove (lower signal, still destructive)
    /\bfs\.rm(Sync)?\s*\([^)]*recursive/i, // Node fs.rm/rmSync({recursive:true})
    /\bunlink\s/i,
    /drop\s+database/i,
    /drop\s+table/i,
    /truncate\s+table/i,
    /delete\s+from\s+\w+\s*(;|$)/i,      // DELETE FROM t with no WHERE clause
    /mkfs/i,
    /dd\s+if=/i,
    /format\s+[a-z]:/i,                  // Windows format C:
    /\bdiskpart\b/i,
    /:\(\)\s*\{\s*:\s*\|\s*:/,           // fork bomb
];

/**
 * Whether a shell command matches any destructive pattern. Shared so callers
 * (e.g. buildRiskFactors) derive `isDestructive` from the same list classifyRisk
 * uses, instead of maintaining a second copy that can silently fall behind.
 */
export function isDestructiveCommand(command: string): boolean {
    return DESTRUCTIVE_PATTERNS.some(p => p.test(command));
}

/** Deployment/production patterns that escalate to R5. */
const PRODUCTION_PATTERNS = [
    /deploy\s*(--to\s*)?prod/i,
    /kubectl\s+apply/i,
    /terraform\s+apply/i,
    /aws\s+s3\s+cp.*s3:/i,
    /heroku\s+ps:restart/i,
];

/**
 * Classify the risk of a tool invocation dynamically.
 */
export function classifyRisk(factors: RiskFactors): RiskClass {
    let risk: RiskClass = factors.baseRisk;

    // Escalation rules
    if (factors.targetsAuditTrail) {
        risk = 'R5'; // unconditional deny — never covered by allow/require_approval paths
    }

    if (factors.accessesSecrets) {
        risk = escalate(risk, 'R4');
    }

    if (factors.targetsProtectedPath) {
        risk = escalate(risk, 'R3');
    }

    if (factors.isDestructive) {
        risk = escalate(risk, 'R3');
    }

    if (factors.modifiesHistory) {
        risk = escalate(risk, 'R3');
    }

    if (factors.hasExternalVisibility) {
        risk = escalate(risk, 'R4');
    }

    // Command-based escalation for execute_command
    if (factors.command) {
        const cmd = factors.command.toLowerCase();
        for (const p of PRODUCTION_PATTERNS) {
            if (p.test(cmd)) {
                risk = 'R5';
                break;
            }
        }
        if (risk !== 'R5') {
            for (const p of DESTRUCTIVE_PATTERNS) {
                if (p.test(cmd)) {
                    risk = escalate(risk, 'R3');
                    break;
                }
            }
        }
    }

    return risk;
}

function escalate(current: RiskClass, minimum: RiskClass): RiskClass {
    return RISK_ORDER[minimum] > RISK_ORDER[current] ? minimum : current;
}

/**
 * Check if a risk class requires approval by default.
 */
export function requiresApproval(riskClass: RiskClass): boolean {
    return DEFAULT_POLICY[riskClass] === 'require_approval';
}

/**
 * Check if a risk class is denied by default.
 */
export function isDenied(riskClass: RiskClass): boolean {
    return DEFAULT_POLICY[riskClass] === 'deny';
}
