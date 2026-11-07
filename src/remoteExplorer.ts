import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, resolveServerAlias } from './config';
import { SessionState } from './sessionState';
import {
    findMappingForPath,
    findServersForPath,
    getActiveWorkspaceFolder,
    getCurrentWorkspaceFolder,
    normalizeLocalPath,
    selectOrCreateMapping,
    selectServer
} from './serverSelector';
import {
    MappingRoot,
    REMOTE_SCHEME,
    RemoteConnectionManager,
    RemoteFileSystemProvider,
    expandRemotePath,
    isSubPath,
    normalizeRemotePath,
    resolveMappings,
    sameServer,
    toRemoteUri
} from './remoteFs';
import { runRemoteSession, shellQuote } from './run';

const VIEW_ID = 'wwsync.remoteFiles';
const ACTIVE_CONTEXT_KEY = 'wwsync.remoteExplorer.active';
const OUTSIDE_PROJECT_CONTEXT_KEY = 'wwsync.remoteExplorer.outsideProject';
const posix = path.posix;

interface RemoteNode {
    readonly uri: vscode.Uri;
    readonly type: vscode.FileType;
}

interface ExplorerRoot {
    /** Alias as written in ~/.wwsync. */
    alias: string;
    /** Remote folder shown at the top of the tree. */
    path: string;
    /** Remote folder mapped to `localFolder` in ~/.wwsync (the "project folder"). */
    projectPath: string;
    /** All mappings of the server with absolute remote paths, for Compare with Local. */
    mappings: MappingRoot[];
    /** Local folder the panel was opened for. */
    localFolder: string;
}

function isDirectory(type: vscode.FileType): boolean {
    return (type & vscode.FileType.Directory) !== 0;
}

function compareEntries([nameA, typeA]: [string, vscode.FileType], [nameB, typeB]: [string, vscode.FileType]): number {
    const folderA = isDirectory(typeA);
    if (folderA !== isDirectory(typeB)) {
        return folderA ? -1 : 1;
    }
    return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function validateRelativeName(value: string): string | undefined {
    const name = value.trim();
    if (!name) {
        return 'A name must be provided.';
    }
    if (name.startsWith('/')) {
        return 'Enter a name relative to the selected folder.';
    }
    if (name.split('/').some(segment => segment === '.' || segment === '..')) {
        return "'.' and '..' are not allowed.";
    }
    return undefined;
}

function validateSingleName(value: string): string | undefined {
    const name = value.trim();
    if (!name) {
        return 'A name must be provided.';
    }
    if (name.includes('/')) {
        return "The name cannot contain '/'.";
    }
    if (name === '.' || name === '..') {
        return "'.' and '..' are not valid names.";
    }
    return undefined;
}

/**
 * "Remote Files" panel: a tree of the server selected for the current folder (the status bar server),
 * rooted at the mapping's remote folder. It connects only when asked to (Open Remote Folder), never
 * just because the panel is shown. Files open through the `wwsync:` file system provider.
 */
export class RemoteExplorer implements vscode.TreeDataProvider<RemoteNode>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<RemoteNode | undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private readonly treeView: vscode.TreeView<RemoteNode>;
    private readonly disposables: vscode.Disposable[] = [];
    /** Stable node objects: the tree needs the same references for partial refreshes and reveal. */
    private readonly nodes = new Map<string, RemoteNode>();
    private root: ExplorerRoot | undefined;
    /** Session server of the shown folder when it was opened; while connected, the panel follows changes of it. */
    private observedServer: string | undefined;
    /** Set while the panel itself updates the session, so its own listener ignores the change. */
    private updatingSession = false;
    /** Only the latest connect request may set the root (a slow host must not override a later choice). */
    private connectRequest = 0;

    constructor(
        private readonly fileSystem: RemoteFileSystemProvider,
        private readonly connections: RemoteConnectionManager,
        private readonly sessionState: SessionState
    ) {
        this.treeView = vscode.window.createTreeView(VIEW_ID, {
            treeDataProvider: this,
            showCollapseAll: true,
            canSelectMany: true
        });

        this.disposables.push(
            this.treeView,
            this.changeEmitter,
            fileSystem.onDidChangeFile(events => this.onFilesChanged(events)),
            sessionState.onDidChange(() => this.onSessionChanged()),
            vscode.window.onDidChangeActiveTextEditor(editor => this.reveal(editor?.document.uri)),
            this.treeView.onDidChangeVisibility(event => {
                if (event.visible) {
                    this.reveal(vscode.window.activeTextEditor?.document.uri);
                }
            }),
            ...this.registerCommands()
        );
        this.updateView();
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    // ---- TreeDataProvider ----

    getTreeItem(node: RemoteNode): vscode.TreeItem {
        const folder = isDirectory(node.type);
        const item = new vscode.TreeItem(
            node.uri,
            folder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        item.id = node.uri.toString();
        item.tooltip = node.type & vscode.FileType.SymbolicLink ? `${node.uri.path} (symbolic link)` : node.uri.path;
        if (folder) {
            item.contextValue = 'remoteFolder';
        } else {
            item.contextValue = this.findMapping(node.uri.path) ? 'remoteFile.mapped' : 'remoteFile';
            if (node.type & vscode.FileType.File) {
                // vscode.open gives Explorer-like behaviour: preview on click, pinned on double click.
                item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
            }
        }
        return item;
    }

    async getChildren(node?: RemoteNode): Promise<RemoteNode[]> {
        const root = this.root;
        if (!root) {
            return []; // shows the welcome content with the Open Remote Folder button
        }

        const folder = node ? node.uri : toRemoteUri(root.alias, root.path);
        try {
            const entries = await this.fileSystem.readDirectory(folder);
            if (!node) {
                this.treeView.message = entries.length === 0 ? 'This folder is empty.' : undefined;
            }
            return entries
                .sort(compareEntries)
                .map(([name, type]) => this.getNode(toRemoteUri(root.alias, posix.join(folder.path, name)), type));
        } catch (err) {
            if (!node) {
                const notSyncedYet = root.path === root.projectPath && err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
                this.treeView.message = notSyncedYet
                    ? `${root.path} does not exist on ${root.alias} yet. Run Safe Sync to create it.`
                    : `Cannot read ${folder.path}: ${errorMessage(err)}`;
            } else {
                this.showError(err);
            }
            return [];
        }
    }

    getParent(node: RemoteNode): RemoteNode | undefined {
        const root = this.root;
        if (!root) {
            return undefined;
        }
        const parentPath = posix.dirname(node.uri.path);
        if (parentPath === node.uri.path || parentPath === root.path || !isSubPath(root.path, parentPath)) {
            return undefined;
        }
        const uri = toRemoteUri(root.alias, parentPath);
        return this.nodes.get(uri.toString()) ?? this.getNode(uri, vscode.FileType.Directory);
    }

    // ---- Connection & root ----

    private registerCommands(): vscode.Disposable[] {
        const register = <A extends unknown[]>(name: string, handler: (...args: A) => unknown) =>
            vscode.commands.registerCommand(`wwsync.remoteExplorer.${name}`, async (...args: A) => {
                try {
                    await handler(...args);
                } catch (err) {
                    this.showError(err);
                }
            });

        return [
            register('open', () => this.open()),
            register('switchServer', () => this.switchServer()),
            register('refresh', (node?: RemoteNode) => this.refresh(node)),
            register('newFile', (node?: RemoteNode) => this.createEntry(node, false)),
            register('newFolder', (node?: RemoteNode) => this.createEntry(node, true)),
            register('goUp', () => this.goUp()),
            register('goToProjectFolder', () => this.goToProjectFolder()),
            register('setRoot', (node?: RemoteNode) => this.setRootFolder(node)),
            register('openToSide', (node?: RemoteNode) => this.openToSide(node)),
            register('compareWithLocal', (target?: RemoteNode | vscode.Uri) => this.compareWithLocal(target)),
            register('rename', (node?: RemoteNode) => this.rename(node)),
            register('delete', (node?: RemoteNode, nodes?: RemoteNode[]) => this.delete(node, nodes)),
            register('copyPath', (node?: RemoteNode, nodes?: RemoteNode[]) => this.copyPaths(node, nodes, false)),
            register('copyRelativePath', (node?: RemoteNode, nodes?: RemoteNode[]) => this.copyPaths(node, nodes, true)),
            register('openTerminal', (node?: RemoteNode) => this.openTerminal(node)),
            register('disconnect', () => this.disconnect())
        ];
    }

    /** The only way the panel connects by itself: Open Remote Folder (welcome button, status bar menu). */
    private async open(): Promise<void> {
        await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
        // An explicit Open always resolves the current workspace and mapping again, even if the
        // panel was previously navigated up to home or opened for a different local project.
        await this.connectInteractive();
    }

    /**
     * Picks the server and mapping exactly like Safe Sync does: the status bar server without prompts,
     * else a choice among the servers mapped to this folder (or, with no mapping yet, the usual setup flow).
     */
    private async connectInteractive(localFolder?: string): Promise<void> {
        const folder = localFolder ?? await getCurrentWorkspaceFolder();
        if (!folder) {
            vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
            return;
        }
        let serverResult: Awaited<ReturnType<typeof selectServer>>;
        this.updatingSession = true; // selectServer may remember the choice; we connect below ourselves
        try {
            serverResult = await selectServer(loadConfig(), folder, this.sessionState);
        } finally {
            this.updatingSession = false;
        }
        if (!serverResult) {
            return;
        }
        const mappingResult = await selectOrCreateMapping(serverResult.config, serverResult.serverAlias, folder);
        if (mappingResult) {
            await this.connect(serverResult.serverAlias, folder);
        }
    }

    /** Switches between the servers mapped to the panel's folder (the same list as the status bar menu). */
    private async switchServer(): Promise<void> {
        const folder = await this.resolveLocalFolder();
        if (!folder) {
            return;
        }
        const config = loadConfig();
        const mapped = findServersForPath(config, folder);
        if (mapped.length === 0) {
            await this.connectInteractive(folder); // offers to map a server, like Safe Sync
            return;
        }
        const picked = await vscode.window.showQuickPick(
            mapped.map(alias => ({
                label: alias,
                description: findMappingForPath(config.servers[alias], folder)?.remote, // the folder it opens
                detail: this.root?.alias === alias ? 'Currently shown' : undefined
            })),
            { placeHolder: 'Select the server to browse for this folder' }
        );
        if (!picked) {
            return;
        }
        // Keep the status bar in sync; the session listener must not reconnect on its own.
        this.updatingSession = true;
        try {
            this.sessionState.set(folder, picked.label);
        } finally {
            this.updatingSession = false;
        }
        await this.connect(picked.label, folder);
    }

    private async connect(alias: string, localFolder: string): Promise<void> {
        const request = ++this.connectRequest;
        try {
            const root = await vscode.window.withProgress(
                { location: { viewId: VIEW_ID } },
                () => this.buildRoot(alias, localFolder)
            );
            if (request === this.connectRequest) {
                this.setRoot(root);
            }
        } catch (err) {
            if (request === this.connectRequest) {
                this.showConnectionError(err, () => this.connect(alias, localFolder));
            }
        }
    }

    /** Local folder whose mapping the panel shows; reports a missing one like the sync commands do. */
    private async resolveLocalFolder(): Promise<string | undefined> {
        const folder = this.root?.localFolder ?? getActiveWorkspaceFolder() ?? await getCurrentWorkspaceFolder();
        if (!folder) {
            vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
        }
        return folder;
    }

    /** The panel always opens the folder mapped in ~/.wwsync, never a fallback such as the home folder. */
    private async buildRoot(alias: string, localFolder: string): Promise<ExplorerRoot> {
        const config = loadConfig();
        const canonical = resolveServerAlias(config, alias);
        if (!canonical) {
            throw new Error(`Server '${alias}' is not defined in ~/.wwsync`);
        }
        const server = config.servers[canonical];
        const mapping = findMappingForPath(server, localFolder);
        if (!mapping) {
            throw new Error(`Server '${canonical}' has no mapping for ${localFolder} in ~/.wwsync`);
        }
        const home = await this.connections.getHome(canonical);
        const projectPath = expandRemotePath(mapping.remote, home);
        this.connections.log(`[remote] Remote Files: ${canonical}:${projectPath} (mapping of ${localFolder})`);
        return {
            alias: canonical,
            path: projectPath,
            projectPath,
            mappings: resolveMappings(server, home),
            localFolder
        };
    }

    private setRoot(root: ExplorerRoot | undefined): void {
        this.root = root;
        this.observedServer = root ? this.sessionState.get(root.localFolder) : undefined;
        this.nodes.clear();
        this.updateView();
        this.changeEmitter.fire(undefined);
    }

    private updateView(): void {
        const root = this.root;
        this.treeView.description = root ? `${root.alias}: ${root.path}` : undefined;
        this.treeView.message = undefined;
        void vscode.commands.executeCommand('setContext', ACTIVE_CONTEXT_KEY, root !== undefined);
        void vscode.commands.executeCommand('setContext', OUTSIDE_PROJECT_CONTEXT_KEY,
            root !== undefined && root.path !== root.projectPath);
    }

    /**
     * While connected, follows the server chosen in the status bar for the shown folder.
     * A disconnected panel ignores it: it connects only when asked to.
     */
    private onSessionChanged(): void {
        const root = this.root;
        if (!root || this.updatingSession) {
            return;
        }
        const server = this.sessionState.get(root.localFolder);
        if (server === this.observedServer) {
            return;
        }
        this.observedServer = server;
        if (server && !sameServer(root.alias, server)) {
            void this.connect(server, root.localFolder);
        }
    }

    private disconnect(): void {
        const root = this.root;
        if (!root) {
            return;
        }
        this.setRoot(undefined);
        this.connections.disconnect(root.alias);
    }

    private refresh(node?: RemoteNode): void {
        if (!this.root) {
            return;
        }
        if (node) {
            this.changeEmitter.fire(isDirectory(node.type) ? node : this.getParent(node));
            return;
        }
        this.treeView.message = undefined;
        this.changeEmitter.fire(undefined);
    }

    // ---- Navigation ----

    private goUp(): void {
        if (this.root && this.root.path !== '/') {
            this.setRoot({ ...this.root, path: posix.dirname(this.root.path) });
        }
    }

    private setRootFolder(node?: RemoteNode): void {
        const target = node ?? this.treeView.selection[0];
        if (this.root && target && isDirectory(target.type)) {
            this.setRoot({ ...this.root, path: normalizeRemotePath(target.uri.path) });
        }
    }

    /** Back to the mapping's remote folder after going up or into a subfolder. */
    private goToProjectFolder(): void {
        if (this.root && this.root.path !== this.root.projectPath) {
            this.setRoot({ ...this.root, path: this.root.projectPath });
        }
    }

    private reveal(uri: vscode.Uri | undefined): void {
        const root = this.root;
        if (!uri || uri.scheme !== REMOTE_SCHEME || !root || !this.treeView.visible || !sameServer(uri.authority, root.alias)) {
            return;
        }
        if (!vscode.workspace.getConfiguration('explorer').get<boolean | string>('autoReveal', true)) {
            return;
        }
        const remotePath = normalizeRemotePath(uri.path);
        if (remotePath === root.path || !isSubPath(root.path, remotePath)) {
            return;
        }
        const nodeUri = toRemoteUri(root.alias, remotePath);
        const node = this.nodes.get(nodeUri.toString()) ?? this.getNode(nodeUri, vscode.FileType.File);
        this.treeView.reveal(node, { select: true, focus: false }).then(undefined, () => undefined);
    }

    private onFilesChanged(events: readonly vscode.FileChangeEvent[]): void {
        const root = this.root;
        if (!root) {
            return;
        }
        const folders = new Set<string>();
        for (const event of events) {
            if (event.type === vscode.FileChangeType.Changed || event.uri.scheme !== REMOTE_SCHEME || !sameServer(event.uri.authority, root.alias)) {
                continue;
            }
            const changed = normalizeRemotePath(event.uri.path);
            if (isSubPath(changed, root.path)) {
                this.changeEmitter.fire(undefined); // the root itself (or an ancestor) changed
                return;
            }
            if (isSubPath(root.path, changed)) {
                folders.add(posix.dirname(changed));
            }
        }
        for (const folder of folders) {
            if (folder === root.path) {
                this.changeEmitter.fire(undefined);
                return;
            }
        }
        for (const folder of folders) {
            const node = this.nodes.get(toRemoteUri(root.alias, folder).toString());
            if (node) {
                this.changeEmitter.fire(node);
            }
        }
    }

    // ---- File operations ----

    private async createEntry(node: RemoteNode | undefined, folder: boolean): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        const parent = this.folderOf(node ?? this.treeView.selection[0]);
        const value = await vscode.window.showInputBox({
            prompt: folder ? `New folder in ${parent}` : `New file in ${parent}`,
            placeHolder: folder ? 'Folder name (use / for nested folders)' : 'File name (use / to create it in new folders)',
            validateInput: validateRelativeName
        });
        if (!value) {
            return;
        }

        const segments = value.trim().split('/').filter(Boolean);
        let current = parent;
        for (const segment of segments.slice(0, -1)) {
            current = posix.join(current, segment);
            await this.createFolderIfMissing(toRemoteUri(root.alias, current));
        }
        const uri = toRemoteUri(root.alias, posix.join(current, segments[segments.length - 1]));
        if (folder) {
            await this.fileSystem.createDirectory(uri);
            const created = this.getNode(uri, vscode.FileType.Directory);
            this.treeView.reveal(created, { select: true, focus: true }).then(undefined, () => undefined);
        } else {
            await this.fileSystem.writeFile(uri, new Uint8Array(0), { create: true, overwrite: false });
            await vscode.window.showTextDocument(uri, { preview: false });
        }
    }

    private async createFolderIfMissing(uri: vscode.Uri): Promise<void> {
        try {
            await this.fileSystem.createDirectory(uri);
        } catch (err) {
            if (!(err instanceof vscode.FileSystemError && err.code === 'FileExists')) {
                throw err;
            }
        }
    }

    private async rename(node?: RemoteNode): Promise<void> {
        const target = node ?? this.treeView.selection[0];
        const root = this.root;
        if (!target || !root) {
            return;
        }
        const oldPath = normalizeRemotePath(target.uri.path);
        const oldName = posix.basename(oldPath);
        const extension = oldName.lastIndexOf('.');
        const value = await vscode.window.showInputBox({
            prompt: 'Enter the new name',
            value: oldName,
            valueSelection: [0, !isDirectory(target.type) && extension > 0 ? extension : oldName.length],
            validateInput: validateSingleName
        });
        const newName = value?.trim();
        if (!newName || newName === oldName) {
            return;
        }

        const newUri = toRemoteUri(root.alias, posix.join(posix.dirname(oldPath), newName));
        if (newName.toLowerCase() !== oldName.toLowerCase() && await this.exists(newUri)) {
            throw new Error(`A file or folder '${newName}' already exists in ${posix.dirname(oldPath)}.`);
        }
        // A workspace edit moves open editors (including unsaved changes) along with the file.
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(target.uri, newUri, { overwrite: false });
        if (!await vscode.workspace.applyEdit(edit)) {
            // applyEdit does not report why it failed: repeat directly to surface the real error.
            await this.fileSystem.rename(target.uri, newUri, { overwrite: false });
        }
    }

    private async delete(node?: RemoteNode, nodes?: RemoteNode[]): Promise<void> {
        const root = this.root;
        if (!root) {
            return;
        }
        const selected = this.selectionOf(node, nodes);
        // Skip entries inside another selected folder: deleting the folder covers them.
        const targets = selected.filter(item => !selected.some(other =>
            other !== item && isDirectory(other.type) && isSubPath(normalizeRemotePath(other.uri.path), normalizeRemotePath(item.uri.path))));
        if (targets.length === 0) {
            return;
        }

        const names = targets.map(item => posix.basename(item.uri.path));
        const message = targets.length === 1
            ? `Are you sure you want to permanently delete '${names[0]}' on ${root.alias}?`
            : `Are you sure you want to permanently delete the following ${targets.length} files/folders on ${root.alias}?`;
        const list = targets.length === 1 ? '' :
            names.slice(0, 10).join('\n') + (names.length > 10 ? `\n...and ${names.length - 10} more` : '') + '\n\n';
        const choice = await vscode.window.showWarningMessage(
            message,
            { modal: true, detail: `${list}This action is irreversible!` },
            'Delete'
        );
        if (choice !== 'Delete') {
            return;
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `WWSync: deleting on ${root.alias}...` },
            async () => {
                for (const target of targets) {
                    await this.fileSystem.delete(target.uri, { recursive: true });
                }
            });
    }

    private async copyPaths(node: RemoteNode | undefined, nodes: RemoteNode[] | undefined, relative: boolean): Promise<void> {
        const root = this.root;
        const paths = this.selectionOf(node, nodes).map(item => {
            const remotePath = normalizeRemotePath(item.uri.path);
            if (!relative || !root) {
                return remotePath;
            }
            const base = isSubPath(root.projectPath, remotePath) ? root.projectPath : root.path;
            return posix.relative(base, remotePath) || '.';
        });
        if (paths.length > 0) {
            await vscode.env.clipboard.writeText(paths.join('\n'));
        }
    }

    private async openToSide(node?: RemoteNode): Promise<void> {
        const target = node ?? this.treeView.selection[0];
        if (target && !isDirectory(target.type)) {
            await vscode.commands.executeCommand('vscode.open', target.uri, { viewColumn: vscode.ViewColumn.Beside });
        }
    }

    private openTerminal(node?: RemoteNode): void {
        const root = this.root;
        if (!root) {
            return;
        }
        const folder = !node ? root.path
            : isDirectory(node.type) ? normalizeRemotePath(node.uri.path) : posix.dirname(node.uri.path);
        const { server } = this.connections.resolveServer(root.alias);
        runRemoteSession(server.host, shellQuote(folder), server.shell || 'bash');
    }

    private async compareWithLocal(target?: RemoteNode | vscode.Uri): Promise<void> {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        const uri = target instanceof vscode.Uri ? target
            : target?.uri ?? (activeUri?.scheme === REMOTE_SCHEME ? activeUri : this.treeView.selection[0]?.uri);
        if (!uri || uri.scheme !== REMOTE_SCHEME) {
            vscode.window.showInformationMessage('WWSync: open or select a remote file to compare it with the local copy.');
            return;
        }
        const remotePath = normalizeRemotePath(uri.path);
        const localPath = await this.findLocalPath(uri.authority, remotePath);
        if (!localPath) {
            vscode.window.showWarningMessage(`WWSync: '${remotePath}' is not inside a mapped folder of server '${uri.authority}'.`);
            return;
        }
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
            vscode.window.showWarningMessage(`WWSync: local file not found: ${localPath}`);
            return;
        }
        const alias = this.root && sameServer(this.root.alias, uri.authority) ? this.root.alias : uri.authority;
        await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(localPath),
            uri,
            `${posix.basename(remotePath)} (Local ↔ ${alias})`
        );
    }

    // ---- Helpers ----

    private getNode(uri: vscode.Uri, type: vscode.FileType): RemoteNode {
        const key = uri.toString();
        const cached = this.nodes.get(key);
        if (cached && cached.type === type) {
            return cached;
        }
        const node: RemoteNode = { uri, type };
        this.nodes.set(key, node);
        return node;
    }

    private selectionOf(node: RemoteNode | undefined, nodes: RemoteNode[] | undefined): RemoteNode[] {
        if (nodes && nodes.length > 0) {
            return nodes;
        }
        return node ? [node] : [...this.treeView.selection];
    }

    /** Folder for new entries: the folder itself, a file's parent, or the tree root. */
    private folderOf(node: RemoteNode | undefined): string {
        if (!node) {
            return this.root!.path;
        }
        return isDirectory(node.type) ? normalizeRemotePath(node.uri.path) : posix.dirname(node.uri.path);
    }

    /** Mapping containing the remote path, used for Compare with Local. */
    private findMapping(remotePath: string, mappings = this.root?.mappings ?? []): MappingRoot | undefined {
        const preferred = this.root ? normalizeLocalPath(this.root.localFolder) : undefined;
        let best: MappingRoot | undefined;
        for (const mapping of mappings) {
            if (remotePath === mapping.remote || !isSubPath(mapping.remote, remotePath)) {
                continue;
            }
            const longer = !best || mapping.remote.length > best.remote.length;
            const preferredTie = best !== undefined && mapping.remote.length === best.remote.length &&
                preferred !== undefined && normalizeLocalPath(mapping.local) === preferred;
            if (longer || preferredTie) {
                best = mapping;
            }
        }
        return best;
    }

    private async findLocalPath(authority: string, remotePath: string): Promise<string | undefined> {
        let mappings: MappingRoot[];
        if (this.root && sameServer(this.root.alias, authority)) {
            mappings = this.root.mappings;
        } else {
            const { alias, server } = this.connections.resolveServer(authority);
            mappings = resolveMappings(server, await this.connections.getHome(alias));
        }
        const mapping = this.findMapping(remotePath, mappings);
        if (!mapping) {
            return undefined;
        }
        return path.join(mapping.local, ...posix.relative(mapping.remote, remotePath).split('/'));
    }

    private async exists(uri: vscode.Uri): Promise<boolean> {
        try {
            await this.fileSystem.stat(uri);
            return true;
        } catch (err) {
            if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
                return false;
            }
            throw err;
        }
    }

    private showError(err: unknown): void {
        vscode.window.showErrorMessage(`WWSync: ${errorMessage(err)}`);
    }

    private showConnectionError(err: unknown, retry: () => Promise<void>): void {
        vscode.window.showErrorMessage(`WWSync: ${errorMessage(err)}`, 'Retry', 'Show Output').then(choice => {
            if (choice === 'Retry') {
                void retry();
            } else if (choice === 'Show Output') {
                this.connections.showOutput();
            }
        });
    }
}
