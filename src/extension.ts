import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, saveConfig, WWConfig, ServerConfig, Mapping } from './config';
import { selectServer, selectOrCreateMapping } from './serverSelector';
import { runSafeSync, runFullSync } from './rsync';
import { runRemoteSession } from './run';

// Session-based server selection storage
const sessionServerChoice: Map<string, string> = new Map();

export function activate(context: vscode.ExtensionContext) {
    console.log('WWSync extension activated');

    const outputChannel = vscode.window.createOutputChannel('WWSync');

    // Safe Sync command
    const safeSyncCmd = vscode.commands.registerCommand('wwsync.safeSync', async () => {
        await executeSync(outputChannel, false);
    });

    // Full Sync command
    const fullSyncCmd = vscode.commands.registerCommand('wwsync.fullSync', async () => {
        await executeSync(outputChannel, true);
    });

    // Run command
    const runCmd = vscode.commands.registerCommand('wwsync.run', async () => {
        await executeRun(outputChannel);
    });

    context.subscriptions.push(safeSyncCmd, fullSyncCmd, runCmd, outputChannel);
}

async function getCurrentWorkspaceFolder(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        // Try to get folder from active editor
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            return path.dirname(activeEditor.document.uri.fsPath);
        }
        return undefined;
    }

    if (workspaceFolders.length === 1) {
        return workspaceFolders[0].uri.fsPath;
    }

    // Multiple workspace folders - let user pick
    const picked = await vscode.window.showQuickPick(
        workspaceFolders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
        { placeHolder: 'Select workspace folder' }
    );
    return picked?.folder.uri.fsPath;
}

async function executeSync(outputChannel: vscode.OutputChannel, fullSync: boolean) {
    try {
        const currentPath = await getCurrentWorkspaceFolder();
        if (!currentPath) {
            vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
            return;
        }

        let config = loadConfig();

        // Select or create server
        const serverResult = await selectServer(config, currentPath, sessionServerChoice);
        if (!serverResult) {
            return; // User cancelled
        }

        config = serverResult.config;
        const serverAlias = serverResult.serverAlias;
        const serverConfig = config.servers[serverAlias];

        // Select or create mapping
        const mappingResult = await selectOrCreateMapping(config, serverAlias, currentPath);
        if (!mappingResult) {
            return; // User cancelled
        }

        config = mappingResult.config;
        const mapping = mappingResult.mapping;

        outputChannel.show(true);

        if (fullSync) {
            await runFullSync(outputChannel, serverConfig.host, mapping);
        } else {
            await runSafeSync(outputChannel, serverConfig.host, mapping);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`WWSync Error: ${error.message}`);
    }
}

async function executeRun(outputChannel: vscode.OutputChannel) {
    try {
        const currentPath = await getCurrentWorkspaceFolder();
        if (!currentPath) {
            vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
            return;
        }

        let config = loadConfig();

        // Select or create server
        const serverResult = await selectServer(config, currentPath, sessionServerChoice);
        if (!serverResult) {
            return;
        }

        config = serverResult.config;
        const serverAlias = serverResult.serverAlias;
        const serverConfig = config.servers[serverAlias];

        // Select or create mapping
        const mappingResult = await selectOrCreateMapping(config, serverAlias, currentPath);
        if (!mappingResult) {
            return;
        }

        const mapping = mappingResult.mapping;
        const shellType = serverConfig.shell || 'bash';

        runRemoteSession(serverConfig.host, mapping.remote, shellType);
    } catch (error: any) {
        vscode.window.showErrorMessage(`WWSync Error: ${error.message}`);
    }
}

export function deactivate() { }
