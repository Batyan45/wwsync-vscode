import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { Mapping } from './config';
import { shellQuotePath } from './run';

/** Thrown when the user cancels an operation; callers should not report it as an error. */
export class CancelledError extends Error {
    constructor() {
        super('Operation cancelled');
        this.name = 'CancelledError';
    }
}

function ensureTrailingSlash(p: string): string {
    return p.endsWith(path.sep) || p.endsWith('/') ? p : p + '/';
}

export async function runSafeSync(
    outputChannel: vscode.OutputChannel,
    host: string,
    mapping: Mapping,
    token?: vscode.CancellationToken,
    env?: NodeJS.ProcessEnv
): Promise<void> {
    const src = ensureTrailingSlash(mapping.local);
    const dest = `${host}:${mapping.remote}`;

    outputChannel.appendLine('');
    outputChannel.appendLine('═══════════════════════════════════════════════════════════');
    outputChannel.appendLine(`>>> Syncing (Safe Mode): ${mapping.local} -> ${host}:${mapping.remote}`);
    outputChannel.appendLine('Files missing locally will NOT be deleted on the server.');
    outputChannel.appendLine('═══════════════════════════════════════════════════════════');

    const args = buildRsyncArgs(mapping.excludes, false);
    args.push(src, dest);

    return runRsyncCommand(outputChannel, args, 'Safe sync', token, env);
}

export async function runFullSync(
    outputChannel: vscode.OutputChannel,
    host: string,
    mapping: Mapping,
    token?: vscode.CancellationToken,
    env?: NodeJS.ProcessEnv
): Promise<void> {
    const src = ensureTrailingSlash(mapping.local);
    const dest = `${host}:${mapping.remote}`;

    outputChannel.appendLine('');
    outputChannel.appendLine('═══════════════════════════════════════════════════════════');
    outputChannel.appendLine(`>>> Full Sync (Full Mode): ${mapping.local} -> ${host}:${mapping.remote}`);
    outputChannel.appendLine('Checking for files to delete on remote...');
    outputChannel.appendLine('═══════════════════════════════════════════════════════════');

    // First, dry run to check for deletions (informational)
    const dryRunArgs = buildRsyncArgs(mapping.excludes, true);
    dryRunArgs.push('--dry-run', src, dest);

    try {
        const dryRunOutput = await runRsyncForOutput(outputChannel, dryRunArgs, token, env);
        const filesToDelete = parseDeletedFiles(dryRunOutput);

        if (filesToDelete.length > 0) {
            outputChannel.appendLine('');
            outputChannel.appendLine('⚠️  WARNING! The following files will be DELETED on the server:');
            filesToDelete.forEach(f => outputChannel.appendLine(`  - ${f}`));
            outputChannel.appendLine('');
            outputChannel.appendLine(`Total files to delete: ${filesToDelete.length}`);
        }

        outputChannel.appendLine('');
        outputChannel.appendLine('The remote folder will be completely recreated.');

        const confirm = await vscode.window.showWarningMessage(
            filesToDelete.length > 0
                ? `${filesToDelete.length} file(s) will be DELETED on the server. The remote folder will be completely recreated. (See WWSync output for details)\nContinue?`
                : `The remote folder will be completely recreated.\nContinue?`,
            { modal: true },
            'Yes, continue'
        );

        if (confirm !== 'Yes, continue') {
            outputChannel.appendLine('Operation cancelled.');
            vscode.window.showInformationMessage('Full sync cancelled.');
            return;
        }

        // Recreate remote directory (rm -rf contents, then mkdir -p)
        outputChannel.appendLine('Recreating remote directory...');
        // Quoted: an unquoted path with a space would make rm -rf delete two other paths.
        const remotePath = shellQuotePath(mapping.remote);
        const recreateCmd = `rm -rf ${remotePath} && mkdir -p ${remotePath}`;
        await runSshCommand(outputChannel, host, recreateCmd, token, env);

        // Upload all content fresh (no --delete needed since dir is empty)
        outputChannel.appendLine('Uploading all files...');
        const uploadArgs = buildRsyncArgs(mapping.excludes, false);
        uploadArgs.push(src, dest);

        await runRsyncCommand(outputChannel, uploadArgs, 'Full sync', token, env);
        outputChannel.appendLine('Remote folder recreated successfully.');
    } catch (error) {
        if (!(error instanceof CancelledError)) {
            outputChannel.appendLine(`Error: ${errorMessage(error)}`);
        }
        throw error;
    }
}

export async function downloadRemoteArtifacts(
    outputChannel: vscode.OutputChannel,
    host: string,
    serverAlias: string,
    mapping: Mapping,
    token?: vscode.CancellationToken,
    env?: NodeJS.ProcessEnv
): Promise<void> {
    const artifactExcludes = mapping.artifact_excludes ?? [];
    const allExcludes = Array.from(new Set([...(mapping.excludes ?? []), ...artifactExcludes]));
    const localRoot = mapping.local;
    const artifactsDir = path.join(localRoot, `.wwsync_${serverAlias}_artifacts`);

    outputChannel.appendLine('');
    outputChannel.appendLine('===========================================================');
    outputChannel.appendLine(`>>> Collecting remote artifacts: ${host}:${mapping.remote}`);
    outputChannel.appendLine('===========================================================');

    const dryRunArgs = buildRemoteDiffArgs(host, localRoot, mapping.remote, allExcludes);
    let dryRunOutput = '';
    try {
        dryRunOutput = await runRsyncForOutput(outputChannel, dryRunArgs, token, env);
    } catch (error) {
        if (error instanceof CancelledError) {
            throw error;
        }
        outputChannel.appendLine(`Error: ${errorMessage(error)}`);
        throw new Error(`Failed to collect remote changes: ${errorMessage(error)}`);
    }

    const { newFiles, changedFiles } = parseRsyncItemizedOutput(dryRunOutput);

    if (changedFiles.length > 0) {
        outputChannel.appendLine('');
        outputChannel.appendLine("Warning: changed files detected on remote (won't be downloaded):");
        changedFiles.forEach(file => outputChannel.appendLine(`  - ${file}`));
        vscode.window.showWarningMessage(
            `${changedFiles.length} changed remote file(s) detected. They were skipped (see WWSync output).`
        );
    }

    const canContinue = await resetArtifactsDirWithConfirmation(artifactsDir);
    if (!canContinue) {
        outputChannel.appendLine('Operation cancelled.');
        return;
    }

    if (newFiles.length === 0) {
        outputChannel.appendLine('No new remote files found. Artifacts directory is empty.');
        vscode.window.showInformationMessage('No new remote files found.');
        return;
    }

    const tempFile = path.join(os.tmpdir(), `wwsync-artifacts-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    try {
        await fs.writeFile(tempFile, `${newFiles.join('\n')}\n`, 'utf-8');

        const downloadArgs = [
            '-azP',
            '--files-from', tempFile,
            `${host}:${ensureTrailingSlash(mapping.remote)}`,
            ensureTrailingSlash(artifactsDir)
        ];

        await runRsyncCommand(outputChannel, downloadArgs, 'Artifacts download', token, env);
        outputChannel.appendLine(`Downloaded ${newFiles.length} new remote file(s) into ${path.basename(artifactsDir)}.`);
    } finally {
        await fs.rm(tempFile, { force: true }).catch(() => undefined);
    }
}

function buildRemoteDiffArgs(host: string, localPath: string, remotePath: string, excludes: string[]): string[] {
    const args = ['-az', '--dry-run', '--itemize-changes', '--out-format=%i\t%n'];

    for (const exc of excludes) {
        args.push('--exclude', exc);
    }

    args.push(`${host}:${ensureTrailingSlash(remotePath)}`, ensureTrailingSlash(localPath));
    return args;
}

async function resetArtifactsDirWithConfirmation(artifactsDir: string): Promise<boolean> {
    try {
        await fs.access(artifactsDir);
        const overwrite = await vscode.window.showWarningMessage(
            `Artifacts directory '${path.basename(artifactsDir)}' already exists. Delete and recreate it?`,
            { modal: true },
            'Yes, overwrite'
        );
        if (overwrite !== 'Yes, overwrite') {
            return false;
        }
        await fs.rm(artifactsDir, { recursive: true, force: true });
    } catch {
        // Directory doesn't exist, nothing to remove.
    }

    await fs.mkdir(artifactsDir, { recursive: true });
    return true;
}

export function parseRsyncItemizedOutput(output: string): { newFiles: string[]; changedFiles: string[] } {
    const newFiles: string[] = [];
    const changedFiles: string[] = [];

    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        // Expected --out-format=%i\t%n line format:
        // >f+++++++++\tpath/to/file
        // >f..t......\tpath/to/file
        if (!trimmed.includes('\t')) {
            continue;
        }

        const [itemCode, ...rest] = trimmed.split('\t');
        const relPath = rest.join('\t').trim();

        if (!relPath) {
            continue;
        }

        if (!itemCode.startsWith('>f')) {
            continue;
        }

        if (itemCode === '>f+++++++++') {
            newFiles.push(relPath);
        } else {
            changedFiles.push(relPath);
        }
    }

    return {
        newFiles: Array.from(new Set(newFiles)),
        changedFiles: Array.from(new Set(changedFiles))
    };
}

function buildRsyncArgs(excludes: string[], withDelete: boolean): string[] {
    const args = ['-avzP'];

    for (const exc of excludes) {
        args.push('--exclude', exc);
    }

    if (withDelete) {
        args.push('--delete', '--force');
    }

    return args;
}

export function parseDeletedFiles(output: string): string[] {
    const lines = output.split('\n');
    const files: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('deleting ')) {
            files.push(trimmed);
        }
    }

    return files;
}

async function runSshCommand(
    outputChannel: vscode.OutputChannel,
    host: string,
    command: string,
    token?: vscode.CancellationToken,
    env?: NodeJS.ProcessEnv
): Promise<void> {
    const result = await runProcess('ssh', [host, command], { token, env, onStderr: text => outputChannel.append(text) });
    if (result.code !== 0) {
        throw new Error(failureReason(result, 'ssh'));
    }
}

/** Runs rsync and returns its stdout (for dry runs); stderr goes to the output channel. */
async function runRsyncForOutput(
    outputChannel: vscode.OutputChannel,
    args: string[],
    token?: vscode.CancellationToken,
    env?: NodeJS.ProcessEnv
): Promise<string> {
    const result = await runProcess('rsync', args, { token, env, collectStdout: true, onStderr: text => outputChannel.append(text) });
    if (result.code !== 0) {
        throw new Error(failureReason(result, 'rsync'));
    }
    return result.stdout;
}

async function runRsyncCommand(
    outputChannel: vscode.OutputChannel,
    args: string[],
    operationName: string,
    token?: vscode.CancellationToken,
    env?: NodeJS.ProcessEnv
): Promise<void> {
    outputChannel.appendLine(`Running: rsync ${args.join(' ')}`);
    outputChannel.appendLine('');

    const result = await runProcess('rsync', args, {
        token,
        env,
        onStdout: text => outputChannel.append(text),
        onStderr: text => outputChannel.append(text)
    });

    outputChannel.appendLine('');
    if (result.code !== 0) {
        outputChannel.appendLine(`✖ ${operationName} failed with code ${result.code}.`);
        throw new Error(`${operationName} failed: ${failureReason(result, 'rsync')}`);
    }
    outputChannel.appendLine(`✔ ${operationName} completed successfully.`);
    vscode.window.setStatusBarMessage(`${operationName} completed successfully.`, 5000);
}

interface ProcessResult {
    code: number | null;
    stdout: string;
    /** The last few KB of stderr, for error messages. */
    stderr: string;
}

/**
 * Spawns a command and resolves when it exits. On cancellation the whole process tree is killed
 * (rsync starts ssh as a child) and CancelledError is thrown only after the process has exited,
 * so a following run never overlaps with a dying one.
 */
function runProcess(command: string, args: string[], options: {
    token?: vscode.CancellationToken;
    env?: NodeJS.ProcessEnv;
    collectStdout?: boolean;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
}): Promise<ProcessResult> {
    if (options.token?.isCancellationRequested) {
        return Promise.reject(new CancelledError());
    }
    return new Promise((resolve, reject) => {
        const proc = cp.spawn(command, args, {
            env: { ...process.env, ...options.env },
            // On POSIX give the process its own group, so cancelling can stop its children too.
            detached: process.platform !== 'win32'
        });
        let stdout = '';
        let stderr = '';
        let cancelled = false;
        const cancellation = options.token?.onCancellationRequested(() => {
            cancelled = true;
            killProcessTree(proc);
        });

        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        proc.stdout.on('data', (text: string) => {
            if (options.collectStdout) {
                stdout += text;
            }
            options.onStdout?.(text);
        });
        proc.stderr.on('data', (text: string) => {
            stderr = (stderr + text).slice(-8192);
            options.onStderr?.(text);
        });

        proc.on('error', (error: NodeJS.ErrnoException) => {
            cancellation?.dispose();
            reject(error.code === 'ENOENT' ? new Error(`'${command}' was not found. Install it or add it to PATH.`) : error);
        });
        proc.on('close', (code: number | null) => {
            cancellation?.dispose();
            if (cancelled) {
                reject(new CancelledError());
            } else {
                resolve({ code, stdout, stderr });
            }
        });
    });
}

function killProcessTree(proc: cp.ChildProcess): void {
    if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) {
        return;
    }
    if (process.platform === 'win32') {
        cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']).on('error', () => proc.kill());
        return;
    }
    try {
        process.kill(-proc.pid, 'SIGTERM'); // the whole process group: rsync and its ssh
    } catch {
        proc.kill();
    }
}

/** The line that explains a failure (e.g. "ssh: Could not resolve hostname ..."), not rsync's generic summary. */
function failureReason(result: ProcessResult, command: string): string {
    const lines = result.stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('**'));
    const specific = lines.filter(line => !/^rsync error:|^rsync: connection unexpectedly closed/.test(line));
    return specific.pop() ?? lines.pop() ?? `${command} exited with code ${result.code}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
