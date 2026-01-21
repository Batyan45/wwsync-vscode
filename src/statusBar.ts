import * as vscode from 'vscode';
import * as path from 'path';
import { SessionState } from './sessionState';
import { loadConfig } from './config';
import { findServersForPath } from './serverSelector';

export class WWSyncStatusBar {
    private statusBarItem: vscode.StatusBarItem;
    private context: vscode.ExtensionContext;
    private sessionState: SessionState;

    constructor(context: vscode.ExtensionContext, sessionState: SessionState) {
        this.context = context;
        this.sessionState = sessionState;

        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.command = 'wwsync.showMenu';
        this.context.subscriptions.push(this.statusBarItem);

        // Listen for changes
        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.update()),
            this.sessionState.onDidChange(() => this.update()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('wwsync.showStatusBar')) {
                    this.updateVisibility();
                }
            })
        );

        this.updateVisibility();
    }

    private updateVisibility() {
        const config = vscode.workspace.getConfiguration('wwsync');
        const show = config.get<boolean>('showStatusBar', true);
        if (show) {
            this.update();
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    private async getCurrentWorkspaceFolder(): Promise<string | undefined> {
        // 1. Try active text editor
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
            if (workspaceFolder) {
                return workspaceFolder.uri.fsPath;
            }
        }

        // 2. Try to get workspace folders if single root
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length === 1) {
            return workspaceFolders[0].uri.fsPath;
        }

        return undefined;
    }

    private async getServerForCurrentFolder(currentPath: string): Promise<string | undefined> {
        // Check session state first
        const sessionServer = this.sessionState.get(currentPath);
        if (sessionServer) {
            return sessionServer;
        }

        // If no session state, check if there's only one configured server for this path
        const config = loadConfig();
        const servers = findServersForPath(config, currentPath);

        if (servers.length === 1) {
            // Auto-select the only available server
            const singleServer = servers[0];
            this.sessionState.set(currentPath, singleServer);
            return singleServer;
        }

        return undefined;
    }

    public async update() {
        if (!vscode.workspace.getConfiguration('wwsync').get('showStatusBar', true)) {
            this.statusBarItem.hide();
            return;
        }

        const currentPath = await this.getCurrentWorkspaceFolder();

        if (!currentPath) {
            this.statusBarItem.text = '$(sync) WWSync';
            this.statusBarItem.tooltip = 'WWSync: No active workspace folder';
        } else {
            const serverName = await this.getServerForCurrentFolder(currentPath);
            if (serverName) {
                this.statusBarItem.text = `$(sync) WWSync: ${serverName}`;
                this.statusBarItem.tooltip = `WWSync: Connected to ${serverName}`;
            } else {
                this.statusBarItem.text = '$(sync) WWSync';
                this.statusBarItem.tooltip = 'WWSync: Click to select server';
            }
        }

        this.statusBarItem.show();
    }

    public async showMenu() {
        let currentPath = await this.getCurrentWorkspaceFolder();

        if (!currentPath) {
            // If multiple workspaces, let user pick one to operate on
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 1) {
                const picked = await vscode.window.showQuickPick(
                    workspaceFolders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f })),
                    { placeHolder: 'Select workspace folder' }
                );
                if (picked) {
                    currentPath = picked.folder.uri.fsPath;
                } else {
                    return;
                }
            } else {
                vscode.window.showInformationMessage('Open a folder to use WWSync');
                return;
            }
        }

        if (!currentPath) return;

        const config = loadConfig();
        // Filter servers that have a mapping for this folder
        const servers = findServersForPath(config, currentPath);
        const currentServer = this.sessionState.get(currentPath);

        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = 'WWSync Actions';

        const actionItems: vscode.QuickPickItem[] = [
            { label: '$(cloud-upload) Safe Sync', description: 'wwsync.safeSync' },
            { label: '$(sync) Full Sync', description: 'wwsync.fullSync' },
            { label: '$(terminal) Run Remote Session', description: 'wwsync.run' }
        ];

        const separator: vscode.QuickPickItem = { label: 'Select Default Server', kind: vscode.QuickPickItemKind.Separator };

        let serverItems: vscode.QuickPickItem[] = [];

        if (servers.length === 0) {
            serverItems = [{ label: 'No configured servers for this folder', description: 'Add a new server via sync command', alwaysShow: true }];
        } else {
            serverItems = servers.map(server => ({
                label: server,
                description: server === currentServer ? '(Selected)' : '',
                picked: server === currentServer
            }));
        }

        quickPick.items = [...actionItems, separator, ...serverItems];

        quickPick.onDidChangeSelection(async selection => {
            const selected = selection[0];
            if (selected) {
                quickPick.hide();

                // Check if it's an action
                if (actionItems.some(item => item.label === selected.label)) {
                    vscode.commands.executeCommand(selected.description!);
                }
                // It's a server selection
                else if (servers.includes(selected.label)) {
                    this.sessionState.set(currentPath!, selected.label);
                }
            }
        });

        quickPick.onDidHide(() => quickPick.dispose());
        quickPick.show();
    }
}
