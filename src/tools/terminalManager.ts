import * as vscode from 'vscode';

/** Manages a single shared VS Code terminal instance for tool execution. */
export class TerminalManager {
    private terminal: vscode.Terminal | null = null;

    /** Return the existing terminal, or create a new one named "CodeOn". */
    public getOrCreateTerminal(): vscode.Terminal {
        if (this.terminal && this.terminal.exitStatus === undefined) {
            return this.terminal;
        }
        this.terminal = vscode.window.createTerminal({ name: 'CodeOn' });
        return this.terminal;
    }

    /** Send a command string to the terminal and optionally reveal the panel. */
    public sendCommand(command: string, reveal: boolean = true): void {
        const term = this.getOrCreateTerminal();
        term.sendText(command);
        if (reveal) {
            term.show(true);
        }
    }

    /** Kill the terminal on extension deactivate. */
    public dispose(): void {
        this.terminal?.dispose();
        this.terminal = null;
    }

    /** Whether the terminal process is currently running. */
    public isAlive(): boolean {
        return this.terminal !== null && this.terminal.exitStatus === undefined;
    }
}

/** Singleton instance shared across the extension. */
export const terminalManager = new TerminalManager();
