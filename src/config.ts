import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Mapping {
    local: string;
    remote: string;
    excludes: string[];
}

export interface ServerConfig {
    host: string;
    shell?: string;
    mappings: Mapping[];
}

export interface WWConfig {
    servers: { [key: string]: ServerConfig };
}

const CONFIG_PATH = path.join(os.homedir(), '.wwsync');

export function loadConfig(): WWConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
        const defaultConfig: WWConfig = {
            servers: {
                example: {
                    host: "user@192.168.1.10",
                    mappings: [
                        {
                            local: "/Users/user/projects/my-app",
                            remote: "/var/www/my-app",
                            excludes: [".git", "node_modules", "build", ".env", "*.log"]
                        }
                    ]
                }
            }
        };
        saveConfig(defaultConfig);
        return defaultConfig;
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
