import * as vscode from 'vscode';
import * as path from 'path';
import { WWConfig, Mapping, ServerConfig, saveConfig } from './config';
import { SessionState } from './sessionState';
import { REMOTE_SCHEME } from './remoteFs';

interface ServerSelectionResult {
    config: WWConfig;
    serverAlias: string;
}

interface MappingSelectionResult {
    config: WWConfig;
    mapping: Mapping;
}

/** Windows paths ignore case; Linux/WSL paths must retain it when matching mappings. */
export function normalizeLocalPath(p: string): string {
    const normalized = path.normalize(p);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Local folder to sync: the single workspace folder, a picked one when several are open,
 * or the active file's folder when no folder is open. Remote (wwsync:) folders/files are ignored.
 */
export async function getCurrentWorkspaceFolder(): Promise<string | undefined> {
    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme !== REMOTE_SCHEME);
    if (workspaceFolders.length === 0) {
        // Try to get folder from active editor
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.scheme !== REMOTE_SCHEME) {
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

/** Workspace folder of the active editor, or the only workspace folder. Never prompts. */
export function getActiveWorkspaceFolder(): string | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
        if (workspaceFolder && workspaceFolder.uri.scheme !== REMOTE_SCHEME) {
            return workspaceFolder.uri.fsPath;
        }
    }

    const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme !== REMOTE_SCHEME);
    if (workspaceFolders.length === 1) {
        return workspaceFolders[0].uri.fsPath;
    }

    return undefined;
}

/**
 * Server selected for the folder in this session, or the only server mapped to it (which then
 * becomes the session choice). This is the server shown in the status bar. Never prompts.
 */
export function getRememberedServer(config: WWConfig, currentPath: string, sessionState: SessionState): string | undefined {
    const sessionServer = sessionState.get(currentPath);
    if (sessionServer && Object.prototype.hasOwnProperty.call(config.servers, sessionServer)) {
        return sessionServer;
    }

    const servers = findServersForPath(config, currentPath);
    if (servers.length === 1) {
        sessionState.set(currentPath, servers[0]);
        return servers[0];
    }

    return undefined;
}

export function findMappingForPath(serverConfig: ServerConfig, localPath: string): Mapping | undefined {
    const normalizedPath = normalizeLocalPath(localPath);
    return serverConfig.mappings.find(m => normalizeLocalPath(m.local) === normalizedPath);
}

export function findServersForPath(config: WWConfig, localPath: string): string[] {
    const normalizedPath = normalizeLocalPath(localPath);
    const matches: string[] = [];

    for (const [name, serverConfig] of Object.entries(config.servers)) {
        for (const mapping of serverConfig.mappings) {
            if (normalizeLocalPath(mapping.local) === normalizedPath) {
                matches.push(name);
                break;
            }
        }
    }
    return matches;
}

export async function selectServer(
    config: WWConfig,
    currentPath: string,
    sessionState: SessionState
): Promise<ServerSelectionResult | undefined> {

    const serverNames = Object.keys(config.servers);

    // No servers configured
    if (serverNames.length === 0) {
        const answer = await vscode.window.showInformationMessage(
            'No .wwsync configuration found. Create one?',
            'Yes',
            'No'
        );

        if (answer === 'Yes') {
            return await createNewServer(config);
        }
        return undefined;
    }

    // Treat 'example' configuration as unconfigured IF it's the only one
    if (serverNames.length === 1 && serverNames[0] === 'example') {
        const answer = await vscode.window.showInformationMessage(
            'Only example configuration found. Create a new server?',
            'Yes',
            'No'
        );

        if (answer === 'Yes') {
            return await createNewServer(config);
        }
    }

    // Check session cache first
    const cachedServer = sessionState.get(currentPath);
    if (cachedServer && config.servers[cachedServer]) {
        return { config, serverAlias: cachedServer };
    }

    // Find servers that have mapping for current path
    const matchingServers = findServersForPath(config, currentPath);

    if (matchingServers.length === 1) {
        const singleServer = matchingServers[0];
        sessionState.set(currentPath, singleServer);
        return { config, serverAlias: singleServer };
    }

    if (matchingServers.length > 1) {
        // Multiple matches - let user pick
        const items = matchingServers.map(name => ({
            label: name,
            description: config.servers[name].host
        }));

        items.push({ label: '$(add) Add new server...', description: '' });

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Multiple servers found for this folder. Select one:',
        });

        if (!picked) {
            return undefined;
        }

        if (picked.label.includes('Add new server')) {
            return await createNewServer(config);
        }

        // Ask if should remember for session
        const remember = await vscode.window.showQuickPick(
            [
                { label: 'Yes', description: 'Remember for this session' },
                { label: 'No', description: 'Ask every time' }
            ],
            { placeHolder: 'Remember this choice for the session?' }
        );

        if (remember?.label === 'Yes') {
            sessionState.set(currentPath, picked.label);
        }

        return { config, serverAlias: picked.label };
    }

    // No matching servers - check if any servers exist at all
    if (serverNames.length === 1) {
        return { config, serverAlias: serverNames[0] };
    }

    // Multiple servers but none match current path - let user pick
    const items = serverNames
        .filter(name => name !== 'example')
        .map(name => ({
            label: name,
            description: config.servers[name].host
        }));

    items.push({ label: '$(add) Add new server...', description: '' });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a server:',
    });

    if (!picked) {
        return undefined;
    }

    if (picked.label.includes('Add new server')) {
        return await createNewServer(config);
    }

    return { config, serverAlias: picked.label };
}

async function createNewServer(config: WWConfig): Promise<ServerSelectionResult | undefined> {
    const serverAlias = await vscode.window.showInputBox({
        prompt: 'Enter server alias (e.g. production, staging)',
        placeHolder: 'my-server',
        validateInput: (value) => {
            if (!value) return 'Server alias is required';
            if (config.servers[value]) return 'Server with this name already exists';
            return undefined;
        }
    });

    if (!serverAlias) {
        return undefined;
    }

    const host = await vscode.window.showInputBox({
        prompt: 'Enter connection address',
        placeHolder: 'user@192.168.1.10',
        validateInput: (value) => {
            if (!value) return 'Host address is required';
            return undefined;
        }
    });

    if (!host) {
        return undefined;
    }

    config.servers[serverAlias] = {
        host,
        mappings: []
    };

    saveConfig(config);
    vscode.window.showInformationMessage(`Server '${serverAlias}' added to configuration.`);

    return { config, serverAlias };
}

export async function selectOrCreateMapping(
    config: WWConfig,
    serverAlias: string,
    currentPath: string
): Promise<MappingSelectionResult | undefined> {

    const serverConfig = config.servers[serverAlias];

    // Find existing mapping
    const existingMapping = findMappingForPath(serverConfig, currentPath);

    if (existingMapping) {
        return { config, mapping: existingMapping };
    }

    // Create new mapping
    vscode.window.showInformationMessage(
        `No sync configuration found for this folder on '${serverAlias}'. Let's create one.`
    );

    const remotePath = await vscode.window.showInputBox({
        prompt: 'Enter remote destination path',
        placeHolder: '/var/www/my-app',
        validateInput: (value) => {
            if (!value) return 'Remote path is required';
            return undefined;
        }
    });

    if (!remotePath) {
        return undefined;
    }

    const excludesInput = await vscode.window.showInputBox({
        prompt: 'Enter exclusions separated by commas (e.g. .git, node_modules)',
        placeHolder: '.git, node_modules, build, .env, *.log',
    });

    const excludes = excludesInput
        ? excludesInput.split(',').map(e => e.trim()).filter(e => e)
        : [];

    const artifactExcludesInput = await vscode.window.showInputBox({
        prompt: 'Enter artifact-only exclusions separated by commas (optional)',
        placeHolder: '*.tmp, *.cache, .DS_Store',
    });

    const artifactExcludes = artifactExcludesInput
        ? artifactExcludesInput.split(',').map(e => e.trim()).filter(e => e)
        : [];

    const newMapping: Mapping = {
        local: currentPath,
        remote: remotePath,
        excludes,
        artifact_excludes: artifactExcludes
    };

    serverConfig.mappings.push(newMapping);
    saveConfig(config);
    vscode.window.showInformationMessage('Configuration saved!');

    return { config, mapping: newMapping };
}
