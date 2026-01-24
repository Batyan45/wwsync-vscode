import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionState } from './sessionState';

export class AskPassManager {
    private server: http.Server | undefined;
    private scriptPath: string | undefined;
    private clientScriptPath: string | undefined;

    constructor(private sessionState: SessionState) { }

    public async prepare(): Promise<{ [key: string]: string }> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer(async (req, res) => {
                let body = '';
                req.on('data', chunk => body += chunk.toString());
                req.on('end', async () => {
                    const promptText = body.trim() || 'Password required:';
                    
                    // Check cache
                    const cached = this.sessionState.getPassword(promptText);
                    if (cached) {
                        res.writeHead(200);
                        res.end(cached);
                        return;
                    }

                    // Ask user
                    const password = await vscode.window.showInputBox({
                        prompt: promptText,
                        password: true,
                        ignoreFocusOut: true
                    });

                    if (password !== undefined) {
                        this.sessionState.setPassword(promptText, password);
                        res.writeHead(200);
                        res.end(password);
                    } else {
                        res.writeHead(404); // Cancel or Error
                        res.end();
                    }
                });
            });

            this.server.listen(0, '127.0.0.1', () => {
                const address = this.server?.address();
                if (typeof address === 'object' && address !== null) {
                    const port = address.port;
                    this.createScripts(port).then(env => resolve(env)).catch(reject);
                } else {
                    reject(new Error('Failed to get server port'));
                }
            });
        });
    }

    private async createScripts(port: number): Promise<{ [key: string]: string }> {
        const tmpDir = os.tmpdir();
        const rand = Math.random().toString(36).substring(7);
        
        const isWindows = process.platform === 'win32';
        
        // Client script (Node.js) - same for all platforms
        const clientJs = `
const http = require('http');
const prompt = process.argv.slice(2).join(' ') || 'Password:';
const req = http.request({
    hostname: '127.0.0.1',
    port: ${port},
    method: 'POST'
}, (res) => {
    res.pipe(process.stdout);
});
req.on('error', () => process.exit(1));
req.write(prompt);
req.end();
`;
        this.clientScriptPath = path.join(tmpDir, `askpass-client-${rand}.js`);
        fs.writeFileSync(this.clientScriptPath, clientJs);

        // Get path to Node.js executable
        const nodeExe = process.execPath;

        if (isWindows) {
            // Windows batch script
            const batContent = `@echo off\n"${nodeExe}" "${this.clientScriptPath}" %*`;
            this.scriptPath = path.join(tmpDir, `askpass-${rand}.bat`);
            fs.writeFileSync(this.scriptPath, batContent);
        } else {
            // Unix shell script (Linux, Mac, WSL)
            const shContent = `#!/bin/sh\n"${nodeExe}" "${this.clientScriptPath}" "$@"`;
            this.scriptPath = path.join(tmpDir, `askpass-${rand}.sh`);
            fs.writeFileSync(this.scriptPath, shContent, { mode: 0o755 });
        }

        // Env vars
        return {
            'SSH_ASKPASS': this.scriptPath,
            'SSH_ASKPASS_REQUIRE': 'force', // For OpenSSH 8.4+
            'DISPLAY': 'dummy:0' // Trigger ASKPASS logic
        };
    }

    public cleanup() {
        if (this.server) {
            this.server.close();
            this.server = undefined;
        }
        if (this.clientScriptPath && fs.existsSync(this.clientScriptPath)) {
            try { fs.unlinkSync(this.clientScriptPath); } catch {}
        }
        if (this.scriptPath && fs.existsSync(this.scriptPath)) {
            try { fs.unlinkSync(this.scriptPath); } catch {}
        }
    }
}

