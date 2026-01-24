import * as vscode from 'vscode';

export class SessionState {
    private _serverChoice: Map<string, string> = new Map();
    private _onDidChange = new vscode.EventEmitter<void>();

    public readonly onDidChange = this._onDidChange.event;

    public get(key: string): string | undefined {
        return this._serverChoice.get(key);
    }

    public set(key: string, value: string) {
        const current = this._serverChoice.get(key);
        if (current !== value) {
            this._serverChoice.set(key, value);
            this._onDidChange.fire();
        }
    }

    private _passwords: Map<string, string> = new Map();

    public resetPasswords() {
        this._passwords.clear();
    }

    public getPassword(prompt: string): string | undefined {
        return this._passwords.get(prompt);
    }

    public setPassword(prompt: string, password: string) {
        this._passwords.set(prompt, password);
    }
}
