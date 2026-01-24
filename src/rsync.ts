import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
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

function buildRsyncArgs(excludes: string[], withDelete: boolean): string[] {
    const args = ['-avzP'];

    for (const exc of excludes) {
        args.push('--exclude', exc);
    }

    if (withDelete) {
        args.push('--delete');
    }

    return args;
}

export function parseDeletedFiles(output: string): string[] {
    const lines = output.split('\n');
    const files: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('deleting ')) {
            files.push(trimmed.replace('deleting ', ''));
        }
    }

    return files;
}

async function runRsyncCommandWithOutput(args: string[], token?: vscode.CancellationToken, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = cp.spawn('rsync', args, { shell: true, env: { ...process.env, ...env } });

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

        const proc = cp.spawn('rsync', args, { shell: true, env: { ...process.env, ...env } });

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
