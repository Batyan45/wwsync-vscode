import * as vscode from 'vscode';

/** Quotes a value for the remote POSIX shell. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quotes a remote path but keeps a leading `~/` unquoted, so the remote shell still expands it. */
export function shellQuotePath(remotePath: string): string {
    if (remotePath === '~') {
        return remotePath;
    }
    return remotePath.startsWith('~/') ? `~/${shellQuote(remotePath.slice(2))}` : shellQuote(remotePath);
}

export function runRemoteSession(host: string, remotePath: string, shellType: string): void {
    const remoteCmd = `cd ${remotePath} && exec ${shellType}`;

    const terminal = vscode.window.createTerminal({
        name: `WWSync: ${host}`,
        shellPath: 'ssh',
        shellArgs: ['-t', host, remoteCmd]
    });

    terminal.show();
}
