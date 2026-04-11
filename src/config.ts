import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Mapping {
    local: string;
    remote: string;
    excludes: string[];
    artifact_excludes?: string[];
}

export interface ServerConfig {
    host: string;
    shell?: string;
    mappings: Mapping[];
}

export interface WWConfig {
    general_excludes?: string[];
    servers: { [key: string]: ServerConfig };
}

/**
 * Merge general_excludes with per-mapping excludes, preserving order and removing duplicates.
 */
export function mergeExcludes(generalExcludes: string[] | undefined, mappingExcludes: string[] | undefined): string[] {
    const combined = [...(generalExcludes ?? []), ...(mappingExcludes ?? [])];
    return [...new Map(combined.map(e => [e, e])).values()];
}

const CONFIG_PATH = path.join(os.homedir(), '.wwsync');

export function loadConfig(): WWConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
        // Return empty config instead of creating default file
        const emptyConfig: WWConfig = {
            servers: {}
        };
        // Do NOT saveConfig here.
        return emptyConfig;
    }

    try {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return JSON.parse(content) as WWConfig;
    } catch (error) {
        throw new Error('.wwsync file is corrupted (invalid JSON).');
    }
}

export function saveConfig(config: WWConfig): void {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf-8');
}

export function getConfigPath(): string {
    return CONFIG_PATH;
}
