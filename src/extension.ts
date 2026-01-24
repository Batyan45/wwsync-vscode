import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, saveConfig, WWConfig, ServerConfig, Mapping } from './config';
import { selectServer, selectOrCreateMapping } from './serverSelector';
import { runSafeSync, runFullSync } from './rsync';
import { runRemoteSession } from './run';
import { SessionState } from './sessionState';
import { WWSyncStatusBar } from './statusBar';

import { AskPassManager } from './askPass';

// Session-based server selection storage
const sessionState = new SessionState();
let statusBar: WWSyncStatusBar;

export function activate(context: vscode.ExtensionContext) {

    console.log('WWSync extension activated');

    const outputChannel = vscode.window.createOutputChannel('WWSync');

    // Initialize Status Bar
    statusBar = new WWSyncStatusBar(context, sessionState);

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

    // Show Menu command
    const showMenuCmd = vscode.commands.registerCommand('wwsync.showMenu', async () => {
        await statusBar.showMenu();
    });

    context.subscriptions.push(safeSyncCmd, fullSyncCmd, runCmd, showMenuCmd, outputChannel);
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
    const askPassManager = new AskPassManager(sessionState);
    let env: NodeJS.ProcessEnv | undefined;
    try {
        const currentPath = await getCurrentWorkspaceFolder();
        if (!currentPath) {
            vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
            return;
        }

        let config = loadConfig();

        // Select or create server
        const serverResult = await selectServer(config, currentPath, sessionState);
        if (!serverResult) {
            return; // User cancelled
        }

        config = serverResult.config;
        const serverAlias = serverResult.serverAlias;
        const serverConfig = config.servers[serverAlias];

        // Ensure session state is updated if it was a new selection (selectServer handles this for interactions but good to be safe)
        // actually selectServer handles it if "Remember" is clicked, but if we have a single server or auto-picked, we might want to ensure status bar knows?
        // selectServer updates sessionState if user says "Remember". 
        // If we just picked one for this run, maybe we should also update session state lightly? 
        // Request says "uses one and the same remembered states".
        // Let's assume selectServer logic is sufficient.

        // If the user selected a server in the flow, updating the status bar to reflect that "active" server 
        // for the current action might be nice, but the requirement is "Default server in this directory... remembered state".
        // So update only if we want to "remember" it. 
        // If the user selected "Remember for this session", selectServer called sessionState.set().

        // However, if we simply executed a command, the status bar might still show "WWSync" if no default is set. This is fine.

        // Select or create mapping
        const mappingResult = await selectOrCreateMapping(config, serverAlias, currentPath);
        if (!mappingResult) {
            return; // User cancelled
        }

        config = mappingResult.config;
        const mapping = mappingResult.mapping;


        // Prepare AskPass
        try {
            env = await askPassManager.prepare();
        } catch (err) {
            console.error('Failed to prepare AskPass manager', err);
        }

        outputChannel.show(true);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: fullSync ? 'WWSync: Full Sync' : 'WWSync: Safe Sync',
            cancellable: true
        }, async (progress, token) => {
            if (fullSync) {
                await runFullSync(outputChannel, serverConfig.host, mapping, token, env);
            } else {
                await runSafeSync(outputChannel, serverConfig.host, mapping, token, env);
            }
        });
    } catch (error: any) {
        vscode.window.showErrorMessage(`WWSync Error: ${error.message}`);
    } finally {
        askPassManager.cleanup();
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
        const serverResult = await selectServer(config, currentPath, sessionState);
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
