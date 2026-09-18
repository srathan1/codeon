import * as vscode from 'vscode';

export class ModeManager {
    private currentMode: string;
    private modeDescriptions: Map<string, string>;
    
    constructor(defaultMode: string) {
        this.currentMode = defaultMode;
        // Enforcement note (P5-T12): only `plan` is tool-gated (read-only) and
        // only `build`/`debug` trigger auto-verification. `code-review` and
        // `research` are prompt presets — they steer the model via their system
        // prompt but do NOT restrict which tools it can call. They're kept
        // because the prompts are useful; just don't assume they sandbox edits.
        this.modeDescriptions = new Map([
            ['plan', 'Plan mode: Outlining tasks and breaking down complex problems'],
            ['build', 'Build mode: Implementing solutions with code generation'],
            ['code-review', 'Code Review mode: Analyzing code quality and suggesting improvements'],
            ['debug', 'Debug mode: Identifying and resolving issues in code'],
            ['research', 'Research mode: Gathering information and analyzing concepts']
        ]);
    }
    
    // Switch to a new mode
    switchMode(mode: string, silent = false): void {
        if (this.modeDescriptions.has(mode)) {
            this.currentMode = mode;
            if (!silent) {
                vscode.window.showInformationMessage(`Switched to ${mode} mode`);
            }
        } else if (!silent) {
            vscode.window.showWarningMessage(`Unknown mode: ${mode}`);
        }
    }
    
    // Get current mode
    getCurrentMode(): string {
        return this.currentMode;
    }
    
    // Get description for a mode
    getModeDescription(mode: string): string {
        return this.modeDescriptions.get(mode) || 'Unknown mode';
    }
    
    // Get all available modes
    getAllModes(): string[] {
        return Array.from(this.modeDescriptions.keys());
    }
    
    // Get current mode description
    getCurrentModeDescription(): string {
        return this.modeDescriptions.get(this.currentMode) || 'Unknown mode';
    }
}