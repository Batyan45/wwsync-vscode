import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { Mapping } from './config';

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

    // First, dry run to check for deletions
    const dryRunArgs = buildRsyncArgs(mapping.excludes, true);
    dryRunArgs.push('--dry-run', src, dest);

    try {
        if (token?.isCancellationRequested) {
            return;
        }
        const dryRunOutput = await runRsyncCommandWithOutput(dryRunArgs, token, env);
        const filesToDelete = parseDeletedFiles(dryRunOutput);

        if (filesToDelete.length > 0) {
            outputChannel.appendLine('');
            outputChannel.appendLine('⚠️  WARNING! The following files will be DELETED on the server:');
            filesToDelete.forEach(f => outputChannel.appendLine(`  - ${f}`));
            outputChannel.appendLine('');
            outputChannel.appendLine(`Total files to delete: ${filesToDelete.length}`);

            const confirm = await vscode.window.showWarningMessage(
                `${filesToDelete.length} file(s) will be DELETED on the server. (See WWSync output for details)\nContinue?`,
                { modal: true },
                'Yes, delete'
            );

            if (confirm !== 'Yes, delete') {
                outputChannel.appendLine('Operation cancelled.');
                vscode.window.showInformationMessage('Full sync cancelled.');
                return;
            }
        } else {
            outputChannel.appendLine('✔ No files need to be deleted.');
        }

        if (token?.isCancellationRequested) {
            return;
        }

        // Execute real sync
        const syncArgs = buildRsyncArgs(mapping.excludes, true);
        syncArgs.push(src, dest);

        await runRsyncCommand(outputChannel, syncArgs, 'Full sync', token, env);
    } catch (error: any) {
        outputChannel.appendLine(`Error: ${error.message}`);
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
        dryRunOutput = await runRsyncCommandWithOutput(dryRunArgs, token, env);
    } catch (error: any) {
        outputChannel.appendLine(`Error: ${error.message}`);
        throw new Error('Failed to collect remote diff via rsync dry-run.');
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

async function runRsyncCommandWithOutput(args: string[], token?: vscode.CancellationToken, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = cp.spawn('rsync', args, { env: { ...process.env, ...env } });

        if (token) {
            token.onCancellationRequested(() => {
                proc.kill();
                reject(new Error('Operation cancelled'));
            });
        }
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('close', (code: number | null) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(stderr || `rsync exited with code ${code}`));
            }
        });

        proc.on('error', (err: Error) => {
            reject(err);
        });
    });
}

async function runRsyncCommand(
    outputChannel: vscode.OutputChannel,
    args: string[],
    operationName: string,
    token?: vscode.CancellationToken,
    env?: NodeJS.ProcessEnv
): Promise<void> {
    return new Promise((resolve, reject) => {
        outputChannel.appendLine(`Running: rsync ${args.join(' ')}`);
        outputChannel.appendLine('');

        const proc = cp.spawn('rsync', args, { env: { ...process.env, ...env } });

        if (token) {
            token.onCancellationRequested(() => {
                outputChannel.appendLine('');
                outputChannel.appendLine(`✖ ${operationName} cancelled by user.`);
                proc.kill();
            });
        }

        proc.stdout.on('data', (data: Buffer) => {
            outputChannel.append(data.toString());
        });

        proc.stderr.on('data', (data: Buffer) => {
            outputChannel.append(data.toString());
        });

        proc.on('close', (code: number | null) => {
            outputChannel.appendLine('');
            if (code === 0) {
                outputChannel.appendLine(`✔ ${operationName} completed successfully.`);
                vscode.window.setStatusBarMessage(`${operationName} completed successfully.`, 5000);
                resolve();
            } else {
                outputChannel.appendLine(`✖ ${operationName} failed with code ${code}.`);
                vscode.window.showErrorMessage(`${operationName} failed.`);
                reject(new Error(`${operationName} failed with code ${code}`));
            }
        });

        proc.on('error', (err: Error) => {
            outputChannel.appendLine(`Error: ${err.message}`);
            reject(err);
        });
    });
}
