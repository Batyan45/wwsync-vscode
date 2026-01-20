import * as vscode from 'vscode';

export function runRemoteSession(host: string, remotePath: string, shellType: string): void {
    const remoteCmd = `cd ${remotePath} && exec ${shellType}`;

    const terminal = vscode.window.createTerminal({
        name: `WWSync: ${host}`,
        shellPath: 'ssh',
        shellArgs: ['-t', host, remoteCmd]
    });

    terminal.show();
}
