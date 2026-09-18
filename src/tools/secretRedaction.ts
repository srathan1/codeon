/**
 * Secret detection and redaction utilities (PRD §9.4).
 * Scans tool inputs and outputs for suspected secrets and redacts them before
 * they reach the model context, logs, or telemetry.
 */

/** Known secret-like patterns. */
const SECRET_PATTERNS: { name: string; regex: RegExp }[] = [
    { name: 'AWS Access Key', regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g },
    { name: 'AWS Secret Key', regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g },
    { name: 'Private Key', regex: /-----BEGIN\s+(?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA |EC |DSA )?PRIVATE KEY-----/g },
    { name: 'Bearer Token', regex: /bearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
    { name: 'JWT', regex: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g },
    { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
    { name: 'Slack Token', regex: /xox[baprs]-[A-Za-z0-9-]+/g },
    { name: 'Generic API Key', regex: /(?<![A-Za-z0-9_-])(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret)[=_"]\s*["']?[A-Za-z0-9\-._~+/]{16,}/gi },
    { name: 'Connection String', regex: /[A-Za-z]+=[^;\s]+;[A-Za-z]+=[^;\s]+;[A-Za-z]+=[^;\s]+/g },
    { name: 'Email in URL', regex: /https?:\/\/[^@\s]+@/g },
];

/** High-entropy threshold (bits per character). */
const ENTROPY_THRESHOLD = 4.5;
/** Minimum length for entropy check. */
const MIN_ENTROPY_LENGTH = 20;

/** Redaction placeholder. */
const REDACTED = '[REDACTED]';

/**
 * Redact secrets from a string. Returns the redacted string and the number of redactions.
 */
export function redactSecrets(text: string): { text: string; redactionCount: number } {
    let count = 0;

    // Apply known patterns first
    for (const { name: _name, regex } of SECRET_PATTERNS) {
        const matches = text.match(regex);
        if (matches) {
            count += matches.length;
            text = text.replace(regex, REDACTED);
        }
    }

    // Entropy-based detection for unknown secrets
    text = redactHighEntropyStrings(text);
    count += (text.match(/\[REDACTED_HIGH_ENTROPY\]/g)?.length ?? 0);
    text = text.replace(/\[REDACTED_HIGH_ENTROPY\]/g, REDACTED);

    return { text, redactionCount: count };
}

/**
 * Detect and mark high-entropy strings that look like secrets.
 */
function redactHighEntropyStrings(text: string): string {
    // Find potential token-like strings (long alphanumeric sequences)
    const tokenRegex = /\b([A-Za-z0-9\-._~+/]{20,})\b/g;
    let match;
    const replacements: { start: number; end: number }[] = [];

    while ((match = tokenRegex.exec(text)) !== null) {
        const candidate = match[1];
        if (candidate.length >= MIN_ENTROPY_LENGTH && shannonEntropy(candidate) > ENTROPY_THRESHOLD) {
            replacements.push({ start: match.index, end: match.index + candidate.length });
        }
    }

    // Apply replacements in reverse order to preserve indices
    let result = text;
    for (const { start, end } of replacements.reverse()) {
        result = result.slice(0, start) + '[REDACTED_HIGH_ENTROPY]' + result.slice(end);
    }
    return result;
}

/** Calculate Shannon entropy of a string. */
function shannonEntropy(str: string): number {
    const freq: Record<string, number> = {};
    for (const c of str) {
        freq[c] = (freq[c] || 0) + 1;
    }
    let entropy = 0;
    const len = str.length;
    for (const count of Object.values(freq)) {
        const p = count / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

/**
 * Check if a string contains suspected secrets.
 */
export function containsSecrets(text: string): boolean {
    for (const { regex } of SECRET_PATTERNS) {
        if (regex.test(text)) return true;
    }
    return false;
}

/**
 * Recursively redact secrets from any JSON-ish value (string, array, or object).
 * P5-T10: the previous implementation only scanned top-level string values, so a
 * secret written into a nested structure — e.g. apply_multi_edit's `edits` array,
 * where each element's `newContent`/`newText` holds file contents — reached the
 * audit log un-redacted, while the same secret via write_file's top-level
 * `content` string was caught. Recursing closes that asymmetry.
 */
function redactValue(value: unknown): { value: unknown; count: number } {
    if (typeof value === 'string') {
        const result = redactSecrets(value);
        return { value: result.text, count: result.redactionCount };
    }
    if (Array.isArray(value)) {
        let count = 0;
        const out = value.map(v => {
            const r = redactValue(v);
            count += r.count;
            return r.value;
        });
        return { value: out, count };
    }
    if (value && typeof value === 'object') {
        let count = 0;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const r = redactValue(v);
            out[k] = r.value;
            count += r.count;
        }
        return { value: out, count };
    }
    return { value, count: 0 };
}

/**
 * Redact secrets from tool arguments, recursing into nested objects and arrays.
 */
export function redactArgs(args: Record<string, unknown>): { args: Record<string, unknown>; redactionCount: number } {
    const result = redactValue(args);
    return { args: result.value as Record<string, unknown>, redactionCount: result.count };
}

/**
 * Check if an environment variable name looks sensitive.
 */
export function isSensitiveEnvName(name: string): boolean {
    const patterns = [/TOKEN/i, /PASSWORD/i, /SECRET/i, /API_KEY/i, /PRIVATE.?KEY/i, /CREDENTIAL/i, /AUTH/i];
    return patterns.some(p => p.test(name));
}
