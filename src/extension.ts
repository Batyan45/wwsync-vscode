import * as vscode from 'vscode';
import { loadConfig, mergeExcludes } from './config';
import { selectServer, selectOrCreateMapping, getCurrentWorkspaceFolder, normalizeLocalPath } from './serverSelector';
import { runSafeSync, runFullSync, downloadRemoteArtifacts, CancelledError } from './rsync';
import { runRemoteSession } from './run';
import { SessionState } from './sessionState';
import { WWSyncStatusBar } from './statusBar';
import { REMOTE_SCHEME, RemoteConnectionManager, RemoteFileSystemProvider } from './remoteFs';
import { RemoteExplorer } from './remoteExplorer';

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

    // Download artifacts command
    const downloadArtifactsCmd = vscode.commands.registerCommand('wwsync.downloadArtifacts', async () => {
        await executeDownloadArtifacts(outputChannel);
    });

    // Show Menu command
    const showMenuCmd = vscode.commands.registerCommand('wwsync.showMenu', async () => {
        await statusBar.showMenu();
    });

    context.subscriptions.push(safeSyncCmd, fullSyncCmd, runCmd, downloadArtifactsCmd, showMenuCmd, outputChannel);

    // Remote Files panel: wwsync:// file system over a persistent SFTP session per server
    const connections = new RemoteConnectionManager(sessionState, outputChannel);
    const remoteFileSystem = new RemoteFileSystemProvider(connections);
    context.subscriptions.push(
        connections,
        vscode.workspace.registerFileSystemProvider(REMOTE_SCHEME, remoteFileSystem, { isCaseSensitive: true }),
        new RemoteExplorer(remoteFileSystem, connections, sessionState)
    );
}

/** Local folders with a sync or download in progress: two runs on one folder would collide. */
const busyFolders = new Set<string>();

function acquireFolder(folder: string): string | undefined {
    const key = normalizeLocalPath(folder);
    if (busyFolders.has(key)) {
        vscode.window.showWarningMessage('WWSync: a sync or download is already running for this folder.');
        return undefined;
    }
    busyFolders.add(key);
    return key;
}

function reportError(outputChannel: vscode.OutputChannel, operation: string, error: unknown) {
    if (error instanceof CancelledError) {
        outputChannel.appendLine(`✖ ${operation} cancelled.`);
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`WWSync Error: ${message}`, 'Show Output').then(choice => {
        if (choice) {
            outputChannel.show(true);
        }
    });
}

async function executeSync(outputChannel: vscode.OutputChannel, fullSync: boolean) {
    const operation = fullSync ? 'Full Sync' : 'Safe Sync';
    const askPassManager = new AskPassManager(sessionState);
    let env: NodeJS.ProcessEnv | undefined;
    let busyFolder: string | undefined;
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

        busyFolder = acquireFolder(currentPath);
        if (!busyFolder) {
            return;
        }

        // Prepare AskPass
        try {
            env = await askPassManager.prepare();
        } catch (err) {
            console.error('Failed to prepare AskPass manager', err);
        }

        // Merge general_excludes with per-mapping excludes
        const effectiveMapping = {
            ...mapping,
            excludes: mergeExcludes(config.general_excludes, mapping.excludes)
        };

        outputChannel.show(true);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `WWSync: ${operation}`,
            cancellable: true
        }, async (progress, token) => {
            if (fullSync) {
                await runFullSync(outputChannel, serverConfig.host, effectiveMapping, token, env);
            } else {
                await runSafeSync(outputChannel, serverConfig.host, effectiveMapping, token, env);
            }
        });
    } catch (error) {
        reportError(outputChannel, operation, error);
    } finally {
        if (busyFolder) {
            busyFolders.delete(busyFolder);
        }
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

async function executeDownloadArtifacts(outputChannel: vscode.OutputChannel) {
    const askPassManager = new AskPassManager(sessionState);
    let env: NodeJS.ProcessEnv | undefined;
    let busyFolder: string | undefined;
    try {
        const currentPath = await getCurrentWorkspaceFolder();
        if (!currentPath) {
            vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
            return;
        }

        let config = loadConfig();

        const serverResult = await selectServer(config, currentPath, sessionState);
        if (!serverResult) {
            return;
        }

        config = serverResult.config;
        const serverAlias = serverResult.serverAlias;
        const serverConfig = config.servers[serverAlias];

        const mappingResult = await selectOrCreateMapping(config, serverAlias, currentPath);
        if (!mappingResult) {
            return;
        }

        const mapping = mappingResult.mapping;

        busyFolder = acquireFolder(currentPath);
        if (!busyFolder) {
            return;
        }

        try {
            env = await askPassManager.prepare();
        } catch (err) {
            console.error('Failed to prepare AskPass manager', err);
        }

        // Merge general_excludes with per-mapping excludes
        const effectiveMapping = {
            ...mapping,
            excludes: mergeExcludes(config.general_excludes, mapping.excludes)
        };

        outputChannel.show(true);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'WWSync: Download Artifacts',
            cancellable: true
        }, async (_progress, token) => {
            await downloadRemoteArtifacts(outputChannel, serverConfig.host, serverAlias, effectiveMapping, token, env);
        });
    } catch (error) {
        reportError(outputChannel, 'Download Artifacts', error);
    } finally {
        if (busyFolder) {
            busyFolders.delete(busyFolder);
        }
        askPassManager.cleanup();
    }
}

export function deactivate() { }
