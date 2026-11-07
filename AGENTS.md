# AGENTS.md — WWSync VSCode Extension

## Project Overview

**WWSync** is a VSCode extension that wraps [rsync](https://rsync.samba.org/) to synchronize local project directories with remote servers over SSH. It is a TypeScript port of the original Python CLI tool located in `wwsync/wwsync`.

**Config file:** `~/.wwsync` (JSON) — shared between the CLI tool and this extension.

## Architecture

```
src/
├── extension.ts       — Entry point. Registers commands, orchestrates sync/run/download flows.
├── config.ts          — Loads/saves the ~/.wwsync JSON config. Defines WWConfig, ServerConfig, Mapping interfaces.
├── rsync.ts           — Core rsync logic: buildRsyncArgs, runSafeSync, runFullSync, downloadRemoteArtifacts.
├── run.ts             — Opens an SSH terminal session to the remote project folder.
├── serverSelector.ts  — Interactive UI for selecting/creating servers and mappings via QuickPick; shared helpers for the
│                        current workspace folder and the remembered (status bar) server.
├── sessionState.ts    — In-memory session store for server selection per workspace and SSH password caching.
├── statusBar.ts       — Status bar item showing active server; provides a quick-action menu.
├── askPass.ts         — SSH_ASKPASS helper: spins up a local HTTP server to relay password prompts to vscode.window.showInputBox.
├── sftp.ts            — Minimal SFTP v3 client over `ssh -s <host> sftp` (pipelined reads/writes, recursive delete). Must not import `vscode`.
├── remoteFs.ts        — `wwsync://<alias>/<path>` FileSystemProvider + RemoteConnectionManager (one SFTP session per server).
├── remoteExplorer.ts  — "Remote Files" tree view (Activity Bar container `wwsync`) and its commands, incl. Compare with Local.
```

## Key Commands

| Command ID                | Action                                       |
|---------------------------|----------------------------------------------|
| `wwsync.safeSync`         | Upload only, no remote deletes               |
| `wwsync.fullSync`         | Mirror with `--delete` (user confirmation)    |
| `wwsync.downloadArtifacts`| Download new-only remote files into artifacts |
| `wwsync.run`              | Open SSH terminal to remote path              |
| `wwsync.showMenu`         | Status bar quick-action menu                  |
| `wwsync.remoteExplorer.open` | Open the Remote Files panel and connect to the selected server |
| `wwsync.remoteExplorer.*` | Panel actions: switchServer, refresh, newFile, newFolder, goUp, goToProjectFolder, setRoot, openToSide, compareWithLocal, rename, delete, copyPath, copyRelativePath, openTerminal, disconnect |

## Config Schema (`~/.wwsync`)

```jsonc
{
    "general_excludes": [".git", ".DS_Store", "__pycache__"],   // Global excludes (shared across all servers/mappings)
    "servers": {
        "<alias>": {
            "host": "user@ip",
            "shell": "bash",          // optional, default "bash"
            "mappings": [
                {
                    "local": "/absolute/local/path",
                    "remote": "/absolute/remote/path",
                    "excludes": ["node_modules", ".env"],
                    "artifact_excludes": ["*.tmp"]              // optional, extra excludes for artifact downloads
                }
            ]
        }
    }
}
```

## Conventions

- **Upstream reference:** The original Python CLI script is at `wwsync/wwsync`. Feature parity should be maintained — new features in the CLI should be ported here.
- **Language:** TypeScript, targeting VSCode Extension API (`vscode` ^1.74.0).
- **Build:** `npm run compile` (tsc). Watch mode: `npm run watch`.
- **No external runtime deps** — only `@types/vscode`, `@types/node`, eslint, typescript in devDependencies.
- **Rsync spawning:** All rsync/ssh calls go through `runProcess` in `rsync.ts`. Cancelling kills the whole process tree (own process group on POSIX, `taskkill /T` on Windows), waits for exit and throws `CancelledError`, which callers report quietly. Errors carry the explaining stderr line (e.g. the ssh error), not rsync's generic summary. The `AskPassManager` sets up `SSH_ASKPASS` env vars so password prompts route through VS Code's input box.
- **One operation per folder:** `extension.ts` refuses a second sync/download for a local folder while one is running.
- **Exclude merging:** `general_excludes` (top-level) are merged with per-mapping `excludes` before passing to rsync. Duplicates are removed preserving order.
- **Full sync flow:** Remote directory is recreated (`ssh rm -rf && mkdir -p`) before uploading fresh content. This ensures a clean state rather than incremental `--delete`.
- **Remote Files:** VS Code-only feature (no CLI counterpart). The panel connects only on an explicit request (Open Remote Folder / Switch Server), never because it is shown, and resolves server and mapping exactly like the sync commands (`selectServer` + `selectOrCreateMapping`); its root is always the mapping's remote folder (no home-folder fallback). Switch Server only lists servers mapped to the folder. Remote access goes through SFTP, not rsync: `RemoteConnectionManager` spawns `ssh -s <host> sftp` once per server (AskPass only during the handshake) and reconnects after a drop. Remote paths are POSIX — always use `path.posix`. Mapping `remote` values may contain `~`; expand them with `expandRemotePath` (SFTP does not). VS Code lower-cases URI authorities, so resolve aliases from URIs with `resolveServerAlias` / compare with `sameServer`.
