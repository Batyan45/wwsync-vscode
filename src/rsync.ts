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
    mapping: Mapping
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

    return runRsyncCommand(outputChannel, args, 'Safe sync');
}

export async function runFullSync(
    outputChannel: vscode.OutputChannel,
    host: string,
    mapping: Mapping
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
        const dryRunOutput = await runRsyncCommandWithOutput(dryRunArgs);
        const filesToDelete = parseDeletedFiles(dryRunOutput);

        if (filesToDelete.length > 0) {
            outputChannel.appendLine('');
            outputChannel.appendLine('⚠️  WARNING! The following files will be DELETED on the server:');
            filesToDelete.forEach(f => outputChannel.appendLine(`  - ${f}`));
            outputChannel.appendLine('');
            outputChannel.appendLine(`Total files to delete: ${filesToDelete.length}`);

            const confirm = await vscode.window.showWarningMessage(
                `${filesToDelete.length} file(s) will be DELETED on the server. Continue?`,
                { modal: true },
                'Yes, delete',
                'Cancel'
            );

            if (confirm !== 'Yes, delete') {
                outputChannel.appendLine('Operation cancelled.');
                vscode.window.showInformationMessage('Full sync cancelled.');
                return;
            }
        } else {
            outputChannel.appendLine('✔ No files need to be deleted.');
        }

        // Execute real sync
        const syncArgs = buildRsyncArgs(mapping.excludes, true);
        syncArgs.push(src, dest);

        await runRsyncCommand(outputChannel, syncArgs, 'Full sync');
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

function parseDeletedFiles(output: string): string[] {
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

async function runRsyncCommandWithOutput(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const process = cp.spawn('rsync', args, { shell: true });
        let stdout = '';
        let stderr = '';

        process.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        process.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(stderr || `rsync exited with code ${code}`));
            }
        });

        process.on('error', (err) => {
            reject(err);
        });
    });
}

async function runRsyncCommand(
    outputChannel: vscode.OutputChannel,
    args: string[],
    operationName: string
): Promise<void> {
    return new Promise((resolve, reject) => {
        outputChannel.appendLine(`Running: rsync ${args.join(' ')}`);
        outputChannel.appendLine('');

        const process = cp.spawn('rsync', args, { shell: true });

        process.stdout.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        process.stderr.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        process.on('close', (code) => {
            outputChannel.appendLine('');
            if (code === 0) {
                outputChannel.appendLine(`✔ ${operationName} completed successfully.`);
                vscode.window.showInformationMessage(`${operationName} completed successfully.`);
                resolve();
            } else {
                outputChannel.appendLine(`✖ ${operationName} failed with code ${code}.`);
                vscode.window.showErrorMessage(`${operationName} failed.`);
                reject(new Error(`${operationName} failed with code ${code}`));
            }
        });

        process.on('error', (err) => {
            outputChannel.appendLine(`Error: ${err.message}`);
            reject(err);
        });
    });
}
