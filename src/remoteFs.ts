import * as vscode from 'vscode';
import * as path from 'path';
import { SftpAttrs, SftpClient, SftpError, SftpFileKind, SftpStatus, fileKind } from './sftp';
import { loadConfig, resolveServerAlias, ServerConfig } from './config';
import { AskPassManager } from './askPass';
import { SessionState } from './sessionState';

const posix = path.posix;

/** Remote files are addressed as `wwsync://<server alias>/<absolute remote path>`. */
export const REMOTE_SCHEME = 'wwsync';

export function toRemoteUri(alias: string, remotePath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: REMOTE_SCHEME, authority: alias, path: normalizeRemotePath(remotePath) });
}

/**
 * Note: VS Code lower-cases the authority in `Uri.toString()`, so the alias taken from a URI must be
 * resolved case-insensitively (see `resolveServerAlias`) and compared with `sameServer`.
 */
export function parseRemoteUri(uri: vscode.Uri): { alias: string; path: string } {
    return { alias: uri.authority, path: normalizeRemotePath(uri.path) };
}

export function sameServer(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

export function normalizeRemotePath(remotePath: string): string {
    const normalized = posix.normalize('/' + remotePath);
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

/** True when `child` is `parent` itself or lies inside it (both normalized absolute paths). */
export function isSubPath(parent: string, child: string): boolean {
    return child === parent || child.startsWith(parent === '/' ? '/' : parent + '/');
}

/** Expands `~`, `~/x` and relative mapping paths against the remote home folder (SFTP does not). */
export function expandRemotePath(remotePath: string, home: string): string {
    const trimmed = remotePath.trim();
    if (trimmed === '' || trimmed === '~') {
        return normalizeRemotePath(home);
    }
    if (trimmed.startsWith('~/')) {
        return normalizeRemotePath(posix.join(home, trimmed.slice(2)));
    }
    if (!trimmed.startsWith('/')) {
        return normalizeRemotePath(posix.join(home, trimmed));
    }
    return normalizeRemotePath(trimmed);
}

export interface MappingRoot {
    local: string;
    /** Absolute remote path of the mapping. */
    remote: string;
}

export function resolveMappings(server: ServerConfig, home: string): MappingRoot[] {
    return (server.mappings ?? []).map(mapping => ({ local: mapping.local, remote: expandRemotePath(mapping.remote, home) }));
}

interface Connection {
    client: SftpClient;
    home: string;
}

/** One persistent SFTP session per server, shared by the file system provider and the explorer. */
export class RemoteConnectionManager implements vscode.Disposable {
    private readonly connections = new Map<string, Promise<Connection>>();

    constructor(
        private readonly sessionState: SessionState,
        private readonly output: vscode.OutputChannel
    ) { }

    resolveServer(name: string): { alias: string; server: ServerConfig } {
        const config = loadConfig();
        const alias = resolveServerAlias(config, name);
        if (!alias) {
            throw vscode.FileSystemError.Unavailable(`WWSync server '${name}' is not defined in ~/.wwsync`);
        }
        return { alias, server: config.servers[alias] };
    }

    async getClient(name: string): Promise<SftpClient> {
        return (await this.getConnection(name)).client;
    }

    /** Remote home (login) folder of the server; also used to expand `~` in mappings. */
    async getHome(name: string): Promise<string> {
        return (await this.getConnection(name)).home;
    }

    showOutput(): void {
        this.output.show(true);
    }

    disconnect(name: string): void {
        let alias = name;
        try {
            alias = this.resolveServer(name).alias;
        } catch {
            // Server removed from the config: fall back to the given name.
        }
        const connection = this.connections.get(alias);
        if (connection) {
            this.connections.delete(alias);
            connection.then(c => c.client.dispose(), () => undefined);
        }
    }

    dispose(): void {
        for (const connection of this.connections.values()) {
            connection.then(c => c.client.dispose(), () => undefined);
        }
        this.connections.clear();
    }

    private async getConnection(name: string): Promise<Connection> {
        const { alias, server } = this.resolveServer(name);
        const existing = this.connections.get(alias);
        if (existing) {
            return existing;
        }
        const created: Promise<Connection> = this.connect(alias, server.host).then(connection => {
            connection.client.onClose(error => {
                if (this.connections.get(alias) === created) {
                    this.connections.delete(alias);
                }
                this.log(`[remote] Connection to '${alias}' closed: ${error.message}`);
            });
            return connection;
        });
        created.catch(() => {
            if (this.connections.get(alias) === created) {
                this.connections.delete(alias);
            }
        });
        this.connections.set(alias, created);
        return created;
    }

    private async connect(alias: string, host: string): Promise<Connection> {
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `WWSync: connecting to ${alias}...` },
            async () => {
                // AskPass is only needed until authentication is over, i.e. until the SFTP handshake.
                const askPassManager = new AskPassManager(this.sessionState);
                let env: NodeJS.ProcessEnv | undefined;
                try {
                    env = await askPassManager.prepare();
                } catch (err) {
                    console.error('Failed to prepare AskPass manager', err);
                }

                this.log(`[remote] Connecting to '${alias}' (${host}) via SFTP...`);
                try {
                    const client = await SftpClient.connect(host, { env, onStderr: text => this.logStderr(alias, text) });
                    let home: string;
                    try {
                        home = await client.realpath('.');
                    } catch (err) {
                        client.dispose();
                        throw err;
                    }
                    this.log(`[remote] SFTP connected to '${alias}' (login directory for ~ expansion: ${home})`);
                    return { client, home };
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    if (/permission denied/i.test(message)) {
                        // Do not keep replaying a rejected password from the session cache.
                        this.sessionState.resetPasswords();
                    }
                    this.log(`[remote] Failed to connect to '${alias}': ${message}`);
                    throw vscode.FileSystemError.Unavailable(`Cannot connect to '${alias}': ${message}`);
                } finally {
                    askPassManager.cleanup();
                }
            });
    }

    private logStderr(alias: string, text: string): void {
        for (const line of text.split(/\r?\n/)) {
            if (line.trim()) {
                this.log(`[remote:${alias}] ${line.trimEnd()}`);
            }
        }
    }

    /** Writes to the WWSync output channel. */
    log(line: string): void {
        try {
            this.output.appendLine(line);
        } catch {
            // The output channel is already disposed while the extension shuts down.
        }
    }
}

/**
 * Exposes remote files to VS Code, so they open in regular editors and Ctrl+S writes them back.
 * There is no server-side watching: the provider reports its own changes via `onDidChangeFile`.
 */
export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
    private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changeEmitter.event;

    constructor(private readonly connections: RemoteConnectionManager) { }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        return this.run(uri, true, async (client, remotePath) => {
            const attrs = await client.lstat(remotePath);
            if (fileKind(attrs) !== 'symlink') {
                return toFileStat(attrs);
            }
            try {
                return toFileStat(await client.stat(remotePath), vscode.FileType.SymbolicLink);
            } catch {
                return toFileStat(attrs); // dangling link
            }
        });
    }

    readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        return this.run(uri, true, async (client, remotePath) => {
            const entries = await client.readdir(remotePath);
            return Promise.all(entries.map(async (entry): Promise<[string, vscode.FileType]> => {
                const kind = fileKind(entry.attrs, entry.longname);
                if (kind !== 'symlink') {
                    return [entry.filename, toFileType(kind)];
                }
                try {
                    const target = await client.stat(posix.join(remotePath, entry.filename));
                    return [entry.filename, toFileType(fileKind(target)) | vscode.FileType.SymbolicLink];
                } catch {
                    return [entry.filename, vscode.FileType.SymbolicLink];
                }
            }));
        });
    }

    createDirectory(uri: vscode.Uri): Promise<void> {
        return this.run(uri, false, async (client, remotePath) => {
            try {
                await client.mkdir(remotePath);
            } catch (err) {
                // SFTP v3 reports EEXIST as a generic failure.
                if (err instanceof SftpError && err.code === SftpStatus.FAILURE && await lstatOrUndefined(client, remotePath)) {
                    throw vscode.FileSystemError.FileExists(`'${remotePath}' already exists`);
                }
                throw err;
            }
            this.fire(vscode.FileChangeType.Created, uri);
        });
    }

    readFile(uri: vscode.Uri): Promise<Uint8Array> {
        return this.run(uri, true, async (client, remotePath) => {
            const kind = fileKind(await client.stat(remotePath));
            if (kind === 'directory') {
                throw vscode.FileSystemError.FileIsADirectory(`'${remotePath}' is a folder`);
            }
            if (kind === 'other') {
                // FIFOs and devices could block the whole SFTP session or never end.
                throw vscode.FileSystemError.NoPermissions(`'${remotePath}' is not a regular file`);
            }
            return client.readFile(remotePath);
        });
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean }): Promise<void> {
        return this.run(uri, false, async (client, remotePath) => {
            const attrs = await statOrUndefined(client, remotePath);
            if (attrs) {
                if (fileKind(attrs) === 'directory') {
                    throw vscode.FileSystemError.FileIsADirectory(`'${remotePath}' is a folder`);
                }
                if (!options.overwrite) {
                    throw vscode.FileSystemError.FileExists(`'${remotePath}' already exists`);
                }
            } else if (!options.create) {
                throw vscode.FileSystemError.FileNotFound(`No such file: ${remotePath}`);
            }
            await client.writeFile(remotePath, content);
            this.fire(attrs ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri);
        });
    }

    delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
        return this.run(uri, false, async (client, remotePath) => {
            const kind = fileKind(await client.lstat(remotePath));
            if (kind !== 'directory') {
                await client.remove(remotePath); // files and symlinks (never their targets)
            } else if (options.recursive) {
                await client.removeRecursive(remotePath);
            } else {
                await client.rmdir(remotePath);
            }
            this.fire(vscode.FileChangeType.Deleted, uri);
        });
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): Promise<void> {
        return this.run(oldUri, false, async (client, oldPath) => {
            const target = parseRemoteUri(newUri);
            if (newUri.scheme !== REMOTE_SCHEME || !sameServer(target.alias, oldUri.authority)) {
                throw vscode.FileSystemError.NoPermissions('Moving files between different servers is not supported');
            }
            // A case-only rename may hit the source itself on case-insensitive file systems:
            // never delete anything in that case, let the server decide.
            const caseOnly = target.path.toLowerCase() === oldPath.toLowerCase();
            const existing = caseOnly ? undefined : await lstatOrUndefined(client, target.path);
            const replacesFile = existing !== undefined && fileKind(existing) !== 'directory';
            if (existing) {
                if (!options.overwrite) {
                    throw vscode.FileSystemError.FileExists(`'${target.path}' already exists`);
                }
                if (!replacesFile) {
                    await client.removeRecursive(target.path);
                } else if (!client.supportsPosixRename) {
                    await client.remove(target.path);
                }
            }
            if (replacesFile && client.supportsPosixRename) {
                await client.posixRename(oldPath, target.path);
            } else {
                await client.rename(oldPath, target.path);
            }
            this.changeEmitter.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri }
            ]);
        });
    }

    private async run<T>(
        uri: vscode.Uri,
        retryOnLostConnection: boolean,
        operation: (client: SftpClient, remotePath: string) => Promise<T>
    ): Promise<T> {
        const { alias, path: remotePath } = parseRemoteUri(uri);
        try {
            return await operation(await this.connections.getClient(alias), remotePath);
        } catch (err) {
            if (retryOnLostConnection && isConnectionLost(err)) {
                // The pool already dropped the dead session; read-only operations are safe to repeat.
                try {
                    return await operation(await this.connections.getClient(alias), remotePath);
                } catch (retryErr) {
                    throw toFileSystemError(retryErr, uri);
                }
            }
            throw toFileSystemError(err, uri);
        }
    }

    private fire(type: vscode.FileChangeType, uri: vscode.Uri): void {
        this.changeEmitter.fire([{ type, uri }]);
    }
}

function toFileType(kind: SftpFileKind): vscode.FileType {
    switch (kind) {
        case 'file': return vscode.FileType.File;
        case 'directory': return vscode.FileType.Directory;
        case 'symlink': return vscode.FileType.SymbolicLink;
        case 'unknown': return vscode.FileType.File; // the server did not say: assume a regular file
        default: return vscode.FileType.Unknown; // FIFOs, sockets, devices
    }
}

function toFileStat(attrs: SftpAttrs, extraType = 0): vscode.FileStat {
    const mtime = (attrs.mtime ?? 0) * 1000;
    return { type: toFileType(fileKind(attrs)) | extraType, size: attrs.size ?? 0, mtime, ctime: mtime };
}

async function statOrUndefined(client: SftpClient, remotePath: string): Promise<SftpAttrs | undefined> {
    try {
        return await client.stat(remotePath);
    } catch (err) {
        if (err instanceof SftpError && err.code === SftpStatus.NO_SUCH_FILE) {
            return undefined;
        }
        throw err;
    }
}

async function lstatOrUndefined(client: SftpClient, remotePath: string): Promise<SftpAttrs | undefined> {
    try {
        return await client.lstat(remotePath);
    } catch (err) {
        if (err instanceof SftpError && err.code === SftpStatus.NO_SUCH_FILE) {
            return undefined;
        }
        throw err;
    }
}

function isConnectionLost(err: unknown): boolean {
    return err instanceof SftpError && (err.code === SftpStatus.CONNECTION_LOST || err.code === SftpStatus.NO_CONNECTION);
}

function toFileSystemError(err: unknown, uri: vscode.Uri): Error {
    if (err instanceof vscode.FileSystemError) {
        return err;
    }
    if (err instanceof SftpError) {
        switch (err.code) {
            case SftpStatus.NO_SUCH_FILE:
                return vscode.FileSystemError.FileNotFound(`No such file or folder: ${uri.path}`);
            case SftpStatus.PERMISSION_DENIED:
                return vscode.FileSystemError.NoPermissions(`Permission denied: ${uri.path}`);
            case SftpStatus.NO_CONNECTION:
            case SftpStatus.CONNECTION_LOST:
                return vscode.FileSystemError.Unavailable(err.message);
            default:
                return new vscode.FileSystemError(`${err.message} (${uri.path})`);
        }
    }
    return vscode.FileSystemError.Unavailable(err instanceof Error ? err.message : String(err));
}
