import * as vscode from 'vscode';
import * as path from 'path';
import { WWConfig, Mapping, saveConfig } from './config';

interface ServerSelectionResult {
    config: WWConfig;
    serverAlias: string;
}

interface MappingSelectionResult {
    config: WWConfig;
    mapping: Mapping;
}

function normalizePath(p: string): string {
    return path.normalize(p).toLowerCase();
}

function findServersForPath(config: WWConfig, localPath: string): string[] {
    const normalizedPath = normalizePath(localPath);
    const matches: string[] = [];

    for (const [name, serverConfig] of Object.entries(config.servers)) {
        for (const mapping of serverConfig.mappings) {
            if (normalizePath(mapping.local) === normalizedPath) {
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
    sessionCache: Map<string, string>
): Promise<ServerSelectionResult | undefined> {

    const serverNames = Object.keys(config.servers);

    // No servers configured
    if (serverNames.length === 0 || (serverNames.length === 1 && serverNames[0] === 'example')) {
        return await createNewServer(config);
    }

    // Check session cache first
    const cachedServer = sessionCache.get(currentPath);
    if (cachedServer && config.servers[cachedServer]) {
        return { config, serverAlias: cachedServer };
    }

    // Find servers that have mapping for current path
    const matchingServers = findServersForPath(config, currentPath);

    if (matchingServers.length === 1) {
        return { config, serverAlias: matchingServers[0] };
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
            sessionCache.set(currentPath, picked.label);
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
    const normalizedPath = normalizePath(currentPath);

    // Find existing mapping
    const existingMapping = serverConfig.mappings.find(
        m => normalizePath(m.local) === normalizedPath
    );

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

    const newMapping: Mapping = {
        local: currentPath,
        remote: remotePath,
        excludes
    };

    serverConfig.mappings.push(newMapping);
    saveConfig(config);
    vscode.window.showInformationMessage('Configuration saved!');

    return { config, mapping: newMapping };
}
