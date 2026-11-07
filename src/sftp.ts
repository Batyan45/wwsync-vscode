import * as cp from 'child_process';
import * as path from 'path';

/*
 * Minimal SFTP v3 client (draft-ietf-secsh-filexfer-02) running over the system `ssh` binary.
 *
 * `ssh -s <host> sftp` gives a binary channel to the server's sftp-server, so no npm dependencies
 * are needed and ~/.ssh/config, keys and SSH_ASKPASS work exactly as they do for rsync.
 * This module must not import `vscode`: it is exercised from plain Node as well.
 */

const SFTP_VERSION = 3;

const FXP_INIT = 1;
const FXP_VERSION = 2;
const FXP_OPEN = 3;
const FXP_CLOSE = 4;
const FXP_READ = 5;
const FXP_WRITE = 6;
const FXP_LSTAT = 7;
const FXP_OPENDIR = 11;
const FXP_READDIR = 12;
const FXP_REMOVE = 13;
const FXP_MKDIR = 14;
const FXP_RMDIR = 15;
const FXP_REALPATH = 16;
const FXP_STAT = 17;
const FXP_RENAME = 18;
const FXP_EXTENDED = 200;

const FXP_STATUS = 101;
const FXP_HANDLE = 102;
const FXP_DATA = 103;
const FXP_NAME = 104;
const FXP_ATTRS = 105;

const OPEN_READ = 0x01;
const OPEN_WRITE = 0x02;
const OPEN_CREAT = 0x08;
const OPEN_TRUNC = 0x10;

const ATTR_SIZE = 0x01;
const ATTR_UIDGID = 0x02;
const ATTR_PERMISSIONS = 0x04;
const ATTR_ACMODTIME = 0x08;
const ATTR_EXTENDED = 0x80000000;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** READ/WRITE chunk size; 32 KiB is accepted by every common SFTP server. */
const CHUNK_SIZE = 32 * 1024;
/** READ/WRITE requests kept in flight to hide network latency. */
const PIPELINE_DEPTH = 16;
/** Concurrent requests used by recursive deletion. */
const REMOVE_CONCURRENCY = 16;
/** A larger packet means the stream is corrupted (e.g. a login script printed text). */
const MAX_PACKET_LENGTH = 4 * 1024 * 1024;

const POSIX_RENAME_EXTENSION = 'posix-rename@openssh.com';

/** Same safety options OpenSSH's own `sftp` passes: a transparent binary channel, no extras from ssh config. */
const SSH_ARGS = [
    '-T', '-x', '-a', '-e', 'none',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no',
    '-o', 'RemoteCommand=none',
    '-o', 'RequestTTY=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=20'
];

export enum SftpStatus {
    OK = 0,
    EOF = 1,
    NO_SUCH_FILE = 2,
    PERMISSION_DENIED = 3,
    FAILURE = 4,
    BAD_MESSAGE = 5,
    NO_CONNECTION = 6,
    CONNECTION_LOST = 7,
    OP_UNSUPPORTED = 8
}

const STATUS_TEXT: { [code: number]: string } = {
    [SftpStatus.EOF]: 'End of file',
    [SftpStatus.NO_SUCH_FILE]: 'No such file',
    [SftpStatus.PERMISSION_DENIED]: 'Permission denied',
    [SftpStatus.FAILURE]: 'Failure',
    [SftpStatus.BAD_MESSAGE]: 'Bad message',
    [SftpStatus.NO_CONNECTION]: 'No connection',
    [SftpStatus.CONNECTION_LOST]: 'Connection lost',
    [SftpStatus.OP_UNSUPPORTED]: 'Operation unsupported'
};

export class SftpError extends Error {
    constructor(public readonly code: number, message?: string) {
        super(message || STATUS_TEXT[code] || `SFTP error ${code}`);
        this.name = 'SftpError';
    }
}

export interface SftpAttrs {
    size?: number;
    permissions?: number;
    mtime?: number;
}

export interface SftpDirEntry {
    filename: string;
    longname: string;
    attrs: SftpAttrs;
}

/** `unknown` means the server did not report a type; `other` covers FIFOs, sockets and devices. */
export type SftpFileKind = 'file' | 'directory' | 'symlink' | 'other' | 'unknown';

export function fileKind(attrs: SftpAttrs, longname?: string): SftpFileKind {
    if (attrs.permissions !== undefined) {
        switch (attrs.permissions & S_IFMT) {
            case S_IFREG: return 'file';
            case S_IFDIR: return 'directory';
            case S_IFLNK: return 'symlink';
            default: return 'other';
        }
    }
    // Some servers omit permissions; fall back to the `ls -l` style long name.
    const marker = longname ? longname.charAt(0) : '';
    switch (marker) {
        case '': return 'unknown';
        case '-': return 'file';
        case 'd': return 'directory';
        case 'l': return 'symlink';
        default: return 'other';
    }
}

class PacketWriter {
    private readonly parts: Uint8Array[] = [];
    private length = 0;

    constructor(type: number) {
        this.push(Buffer.from([type]));
    }

    uint32(value: number): this {
        const buffer = Buffer.allocUnsafe(4);
        buffer.writeUInt32BE(value >>> 0, 0);
        return this.push(buffer);
    }

    uint64(value: number): this {
        const buffer = Buffer.allocUnsafe(8);
        buffer.writeUInt32BE(Math.floor(value / 0x100000000) >>> 0, 0);
        buffer.writeUInt32BE(value >>> 0, 4);
        return this.push(buffer);
    }

    string(value: string | Uint8Array): this {
        const data = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
        this.uint32(data.length);
        return this.push(data);
    }

    /** An ATTRS structure with no attributes set (server defaults, e.g. umask for new files). */
    noAttrs(): this {
        return this.uint32(0);
    }

    finish(): Buffer {
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(this.length, 0);
        return Buffer.concat([header, ...this.parts], 4 + this.length);
    }

    private push(data: Uint8Array): this {
        this.parts.push(data);
        this.length += data.length;
        return this;
    }
}

class PacketReader {
    private offset = 0;

    constructor(private readonly data: Buffer) { }

    get remaining(): number {
        return this.data.length - this.offset;
    }

    byte(): number {
        this.need(1);
        return this.data[this.offset++];
    }

    uint32(): number {
        this.need(4);
        const value = this.data.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }

    uint64(): number {
        const high = this.uint32();
        const low = this.uint32();
        return high * 0x100000000 + low;
    }

    bytes(): Buffer {
        const length = this.uint32();
        this.need(length);
        const value = this.data.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
    }

    string(): string {
        return this.bytes().toString('utf8');
    }

    attrs(): SftpAttrs {
        const flags = this.uint32();
        const attrs: SftpAttrs = {};
        if (flags & ATTR_SIZE) {
            attrs.size = this.uint64();
        }
        if (flags & ATTR_UIDGID) {
            this.uint32();
            this.uint32();
        }
        if (flags & ATTR_PERMISSIONS) {
            attrs.permissions = this.uint32();
        }
        if (flags & ATTR_ACMODTIME) {
            this.uint32(); // atime
            attrs.mtime = this.uint32();
        }
        if (flags & ATTR_EXTENDED) {
            const count = this.uint32();
            for (let i = 0; i < count; i++) {
                this.bytes();
                this.bytes();
            }
        }
        return attrs;
    }

    private need(count: number): void {
        if (this.offset + count > this.data.length) {
            throw new SftpError(SftpStatus.BAD_MESSAGE, 'Malformed SFTP packet');
        }
    }
}

interface Response {
    type: number;
    reader: PacketReader;
}

interface PendingRequest {
    resolve(response: Response): void;
    reject(error: Error): void;
}

export interface SftpConnectOptions {
    env?: NodeJS.ProcessEnv;
    /** Receives everything ssh writes to stderr (warnings, authentication errors). */
    onStderr?: (text: string) => void;
}

export class SftpClient {
    private readonly proc: cp.ChildProcess;
    private readonly ready: Promise<void>;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly closeListeners: ((error: Error) => void)[] = [];
    private readonly extensions = new Set<string>();
    private handshake: { resolve(): void; reject(error: Error): void } | undefined;
    private buffer: Buffer = Buffer.alloc(0);
    private nextId = 1;
    private stderrTail = '';
    private closedError: Error | undefined;

    /** Spawns `ssh -s <host> sftp` and resolves once the SFTP handshake (and thus authentication) is done. */
    static async connect(host: string, options: SftpConnectOptions = {}): Promise<SftpClient> {
        const client = new SftpClient(host, options);
        await client.ready;
        return client;
    }

    private constructor(host: string, options: SftpConnectOptions) {
        this.ready = new Promise<void>((resolve, reject) => {
            this.handshake = { resolve, reject };
        });

        this.proc = cp.spawn('ssh', [...SSH_ARGS, '-s', '--', host, 'sftp'], {
            env: { ...process.env, ...options.env },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.proc.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
        this.proc.stderr!.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            this.stderrTail = (this.stderrTail + text).slice(-4096);
            options.onStderr?.(text);
        });
        // Writing to a dead process raises EPIPE; the 'close' handler reports the real reason.
        this.proc.stdin!.on('error', () => this.proc.kill());
        this.proc.on('error', (error: Error) => {
            this.fail(new SftpError(SftpStatus.NO_CONNECTION, `Failed to start ssh: ${error.message}`));
        });
        this.proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
            this.fail(new SftpError(SftpStatus.CONNECTION_LOST, this.describeExit(code, signal)));
        });

        this.send(new PacketWriter(FXP_INIT).uint32(SFTP_VERSION).finish());
    }

    get supportsPosixRename(): boolean {
        return this.extensions.has(POSIX_RENAME_EXTENSION);
    }

    /** Called once when the connection ends for any reason (immediately if it already has). */
    onClose(listener: (error: Error) => void): void {
        if (this.closedError) {
            listener(this.closedError);
        } else {
            this.closeListeners.push(listener);
        }
    }

    dispose(): void {
        this.fail(new SftpError(SftpStatus.NO_CONNECTION, 'Connection closed'));
        this.proc.stdin?.end();
        this.proc.kill();
    }

    async realpath(remotePath: string): Promise<string> {
        const reader = expect(await this.request(FXP_REALPATH, p => p.string(remotePath)), FXP_NAME);
        const entries = readNames(reader);
        if (entries.length === 0) {
            throw new SftpError(SftpStatus.BAD_MESSAGE, 'Empty REALPATH response');
        }
        return entries[0].filename;
    }

    /** Attributes of the file, following symlinks. */
    async stat(remotePath: string): Promise<SftpAttrs> {
        return expect(await this.request(FXP_STAT, p => p.string(remotePath)), FXP_ATTRS).attrs();
    }

    /** Attributes of the entry itself (a symlink is reported as a symlink). */
    async lstat(remotePath: string): Promise<SftpAttrs> {
        return expect(await this.request(FXP_LSTAT, p => p.string(remotePath)), FXP_ATTRS).attrs();
    }

    /** Directory entries without `.` and `..`; attributes are lstat-style (symlinks are not followed). */
    async readdir(remotePath: string): Promise<SftpDirEntry[]> {
        const handle = await this.openHandle(FXP_OPENDIR, p => p.string(remotePath));
        const entries: SftpDirEntry[] = [];
        try {
            for (;;) {
                const response = await this.request(FXP_READDIR, p => p.string(handle));
                if (response.type === FXP_STATUS) {
                    const status = readStatus(response.reader);
                    if (status.code === SftpStatus.EOF) {
                        break;
                    }
                    throw status;
                }
                entries.push(...readNames(expect(response, FXP_NAME)));
            }
        } finally {
            await this.closeHandle(handle).catch(() => undefined);
        }
        return entries.filter(entry => entry.filename !== '.' && entry.filename !== '..');
    }

    async readFile(remotePath: string): Promise<Buffer> {
        const handle = await this.openHandle(FXP_OPEN, p => p.string(remotePath).uint32(OPEN_READ).noAttrs());
        try {
            return await this.readAll(handle);
        } finally {
            await this.closeHandle(handle).catch(() => undefined);
        }
    }

    /**
     * Writes the file in place (O_TRUNC), so existing permissions and ownership are preserved.
     * Trade-off: if the connection drops mid-write, the file stays truncated until it is saved again.
     */
    async writeFile(remotePath: string, content: Uint8Array): Promise<void> {
        const handle = await this.openHandle(FXP_OPEN, p => p.string(remotePath).uint32(OPEN_WRITE | OPEN_CREAT | OPEN_TRUNC).noAttrs());
        let failure: unknown;
        try {
            const inflight: Promise<void>[] = [];
            for (let offset = 0; offset < content.length; offset += CHUNK_SIZE) {
                const chunk = content.subarray(offset, Math.min(offset + CHUNK_SIZE, content.length));
                const write = this.request(FXP_WRITE, p => p.string(handle).uint64(offset).string(chunk)).then(expectOk);
                write.catch(() => undefined); // awaited below; avoids unhandled-rejection noise meanwhile
                inflight.push(write);
                if (inflight.length >= PIPELINE_DEPTH) {
                    await inflight.shift();
                }
            }
            await Promise.all(inflight);
        } catch (error) {
            failure = error;
        }
        try {
            await this.closeHandle(handle);
        } catch (error) {
            failure = failure ?? error;
        }
        if (failure) {
            throw failure;
        }
    }

    async mkdir(remotePath: string): Promise<void> {
        expectOk(await this.request(FXP_MKDIR, p => p.string(remotePath).noAttrs()));
    }

    async rmdir(remotePath: string): Promise<void> {
        expectOk(await this.request(FXP_RMDIR, p => p.string(remotePath)));
    }

    async remove(remotePath: string): Promise<void> {
        expectOk(await this.request(FXP_REMOVE, p => p.string(remotePath)));
    }

    /** Plain SFTP rename; fails if the target exists. */
    async rename(fromPath: string, toPath: string): Promise<void> {
        expectOk(await this.request(FXP_RENAME, p => p.string(fromPath).string(toPath)));
    }

    /** rename(2) semantics (replaces an existing file); check `supportsPosixRename` first. */
    async posixRename(fromPath: string, toPath: string): Promise<void> {
        expectOk(await this.request(FXP_EXTENDED, p => p.string(POSIX_RENAME_EXTENSION).string(fromPath).string(toPath)));
    }

    /** Deletes a directory tree. Symlinks are removed as links; their targets are never entered. */
    async removeRecursive(remotePath: string): Promise<void> {
        const limit = createLimiter(REMOVE_CONCURRENCY);
        const removeDirectory = async (directory: string): Promise<void> => {
            const entries = await limit(() => this.readdir(directory));
            await Promise.all(entries.map(entry => {
                const child = path.posix.join(directory, entry.filename);
                return fileKind(entry.attrs, entry.longname) === 'directory'
                    ? removeDirectory(child)
                    : limit(() => this.remove(child));
            }));
            await limit(() => this.rmdir(directory));
        };
        await removeDirectory(remotePath);
    }

    private async readAll(handle: Buffer): Promise<Buffer> {
        const chunks: Buffer[] = [];
        let total = 0;
        let nextOffset = 0;
        const inflight: { offset: number; data: Promise<Buffer | undefined> }[] = [];
        const fill = () => {
            while (inflight.length < PIPELINE_DEPTH) {
                const data = this.readChunk(handle, nextOffset);
                data.catch(() => undefined); // awaited below; avoids unhandled-rejection noise meanwhile
                inflight.push({ offset: nextOffset, data });
                nextOffset += CHUNK_SIZE;
            }
        };

        fill();
        while (inflight.length > 0) {
            const head = inflight.shift()!;
            const data = await head.data;
            if (data === undefined) {
                break; // EOF exactly at a chunk boundary
            }
            chunks.push(data);
            total += data.length;
            if (data.length < CHUNK_SIZE) {
                // Short read: EOF or a server-side cap. Drop the speculative reads and continue
                // sequentially from the exact position, so nothing is ever skipped.
                await Promise.allSettled(inflight.map(item => item.data));
                inflight.length = 0;
                let position = head.offset + data.length;
                for (;;) {
                    const more = await this.readChunk(handle, position);
                    if (more === undefined) {
                        break;
                    }
                    chunks.push(more);
                    total += more.length;
                    position += more.length;
                }
                break;
            }
            fill();
        }
        return Buffer.concat(chunks, total);
    }

    /** Returns undefined at end of file. */
    private async readChunk(handle: Buffer, offset: number): Promise<Buffer | undefined> {
        const response = await this.request(FXP_READ, p => p.string(handle).uint64(offset).uint32(CHUNK_SIZE));
        if (response.type === FXP_STATUS) {
            const status = readStatus(response.reader);
            if (status.code === SftpStatus.EOF) {
                return undefined;
            }
            throw status;
        }
        const data = expect(response, FXP_DATA).bytes();
        return data.length > 0 ? data : undefined;
    }

    private async openHandle(type: number, build: (packet: PacketWriter) => void): Promise<Buffer> {
        return expect(await this.request(type, build), FXP_HANDLE).bytes();
    }

    private async closeHandle(handle: Buffer): Promise<void> {
        expectOk(await this.request(FXP_CLOSE, p => p.string(handle)));
    }

    private request(type: number, build: (packet: PacketWriter) => void): Promise<Response> {
        if (this.closedError) {
            return Promise.reject(this.closedError);
        }
        const id = this.nextId;
        this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
        const packet = new PacketWriter(type).uint32(id);
        build(packet);
        return new Promise<Response>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.send(packet.finish());
        });
    }

    private send(packet: Buffer): void {
        this.proc.stdin!.write(packet);
    }

    private onData(chunk: Buffer): void {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4 && !this.closedError) {
            const length = this.buffer.readUInt32BE(0);
            if (length === 0 || length > MAX_PACKET_LENGTH) {
                this.fail(new SftpError(SftpStatus.BAD_MESSAGE,
                    'Received a corrupted SFTP stream. Make sure the remote shell startup files ' +
                    '(e.g. ~/.bashrc) print nothing for non-interactive sessions.'));
                this.proc.kill();
                return;
            }
            if (this.buffer.length < 4 + length) {
                return;
            }
            const packet = this.buffer.subarray(4, 4 + length);
            this.buffer = this.buffer.subarray(4 + length);
            try {
                this.dispatch(new PacketReader(packet));
            } catch (error) {
                this.fail(error instanceof Error ? error : new Error(String(error)));
                this.proc.kill();
                return;
            }
        }
    }

    private dispatch(reader: PacketReader): void {
        const type = reader.byte();
        if (type === FXP_VERSION) {
            reader.uint32(); // server version; we only speak v3
            while (reader.remaining > 0) {
                this.extensions.add(reader.string());
                reader.bytes(); // extension data
            }
            this.handshake?.resolve();
            this.handshake = undefined;
            return;
        }
        const id = reader.uint32();
        const request = this.pending.get(id);
        if (request) {
            this.pending.delete(id);
            request.resolve({ type, reader });
        }
    }

    private fail(error: Error): void {
        if (this.closedError) {
            return;
        }
        this.closedError = error;
        this.handshake?.reject(error);
        this.handshake = undefined;
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const request of pending) {
            request.reject(error);
        }
        for (const listener of this.closeListeners.splice(0)) {
            try {
                listener(error);
            } catch {
                // A failing listener must not break cleanup of the others.
            }
        }
    }

    private describeExit(code: number | null, signal: NodeJS.Signals | null): string {
        const lines = this.stderrTail
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('**') && !/^Warning: Permanently added/i.test(line));
        if (lines.length > 0) {
            return lines.slice(-3).join(' ');
        }
        if (signal) {
            return `ssh terminated by ${signal}`;
        }
        return code === 0 ? 'Connection closed' : `ssh exited with code ${code}`;
    }
}

function readStatus(reader: PacketReader): SftpError {
    const code = reader.uint32();
    let message = '';
    if (reader.remaining >= 4) {
        try {
            message = reader.string();
        } catch {
            // The message is optional in old servers.
        }
    }
    return new SftpError(code, message);
}

function expect(response: Response, type: number): PacketReader {
    if (response.type === type) {
        return response.reader;
    }
    if (response.type === FXP_STATUS) {
        const status = readStatus(response.reader);
        if (status.code !== SftpStatus.OK) {
            throw status;
        }
    }
    throw new SftpError(SftpStatus.BAD_MESSAGE, `Unexpected SFTP response type ${response.type}`);
}

function expectOk(response: Response): void {
    if (response.type !== FXP_STATUS) {
        throw new SftpError(SftpStatus.BAD_MESSAGE, `Unexpected SFTP response type ${response.type}`);
    }
    const status = readStatus(response.reader);
    if (status.code !== SftpStatus.OK) {
        throw status;
    }
}

function readNames(reader: PacketReader): SftpDirEntry[] {
    const count = reader.uint32();
    const entries: SftpDirEntry[] = [];
    for (let i = 0; i < count; i++) {
        const filename = reader.string();
        const longname = reader.string();
        const attrs = reader.attrs();
        entries.push({ filename, longname, attrs });
    }
    return entries;
}

/** Runs at most `max` tasks at once; a released slot is handed straight to the next waiter. */
function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
    let active = 0;
    const waiting: (() => void)[] = [];
    return async <T>(task: () => Promise<T>): Promise<T> => {
        if (active < max) {
            active++;
        } else {
            await new Promise<void>(resolve => waiting.push(resolve));
        }
        try {
            return await task();
        } finally {
            const next = waiting.shift();
            if (next) {
                next();
            } else {
                active--;
            }
        }
    };
}
