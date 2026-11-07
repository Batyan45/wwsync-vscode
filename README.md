# <img src="images/icon.png" width="64" align="center" alt="icon" /> WWSync for VSCode

A VSCode extension port of the [WWSync](https://github.com/Batyan45/wwsync) tool.

It allows you to synchronize your project with a remote server using `rsync` directly from VSCode, with safeguards against accidental deletions.

## Features

- **Safe Sync** ($(cloud-upload)): Uploads files without deleting anything on the remote server.
- **Full Sync** ($(sync)): Completely recreates the remote folder (rm -rf + mkdir) and uploads all local content fresh (with confirmation).
- **Artifacts Download** ($(cloud-download)): Downloads only new remote files into `.wwsync_<server>_artifacts`. Changed remote files are listed as warning and are not downloaded.
- **Run** ($(terminal)): Opens an SSH session to the project folder.
- **Remote Files** ($(remote-explorer)): Browse the selected server in its own panel and open, edit and save remote files in regular VS Code editors.
- **Interactive Auth**: Handles password and key passphrase prompts with secure input and session-based caching.

## User Interface

WWSync provides two ways to interact with your servers:

1.  **Status Bar**:
    -   Displays the current connected server for the active file's directory (e.g. `WWSync: production`).
    -   Click the status bar item to open a **Reference Menu** where you can run sync commands or switch the default server for the session.
    -   The server list is filtered to only show servers configured for the current workspace folder.

2.  **Title Bar Buttons**:
    -   Quick access buttons in the editor title area for Safe Sync, Full Sync, Download Artifacts, and Run.

3.  **Remote Files panel** (WWSync icon in the Activity Bar):
    -   Run **Browse Remote Files** again to return to the current workspace's configured project folder after navigating elsewhere or updating its mapping.
    -   Showing the panel does not connect anywhere: press **Open Remote Folder** (or use Browse Remote Files from the status bar menu).
    -   It opens the same remote folder that Safe Sync uses for the current folder: the server shown in the status bar (or the only mapped one; with several mapped servers you pick one, as for Safe Sync) and its mapping's remote path from `~/.wwsync`, never the home folder. Use Go to Parent Folder to look above it. While connected, switching the server in the status bar switches the panel too.
    -   Click a file to open it (single click previews, double click keeps the tab, like the Explorer). Edit it and press `Ctrl+S` to save it straight to the server.
    -   Context menu: New File/Folder (`a/b/c.txt` creates the folders too), Rename (`F2`), Delete (`Delete`, multi-select supported), Copy Path / Copy Relative Path, Open in Remote Terminal, Go to This Folder, and **Compare with Local**: a diff of the remote file and its copy in your local project. Compare with Local is also available from the context menu of a remote editor tab.
    -   Toolbar: New File, New Folder, Go to Parent Folder, Go to Project Folder (shown once you leave it), Refresh, Collapse All; the `...` menu has Switch Server (the servers mapped to this folder), Open in Remote Terminal and Disconnect.
    -   Works over a single SFTP session per server through your system `ssh` (keys, `~/.ssh/config` and password prompts work as for sync). `rsync` is not needed for this panel. The server must have the SFTP subsystem enabled, which is the OpenSSH default.
    -   The panel does not watch the server for changes: press Refresh to reload the tree. If a file changed on the server while you were editing it, VS Code asks how to resolve the conflict on save.

## Configuration

You can customize the extension appearance in VSCode Settings:

-   `wwsync.showButtons`: Show/hide the buttons in the editor title bar (default: `true`).
-   `wwsync.showStatusBar`: Show/hide the status bar item (default: `true`).

## Usage

1.  Open a folder in VSCode.
2.  Click the WWSync status bar item or title bar buttons to start.
3.  **Config**: The extension uses a `~/.wwsync` config file. It will prompt you to create it if missing, or add a new server/mapping if none exists for the current directory.

### Config Example

```json
{
    "general_excludes": [".git", ".DS_Store", "__pycache__"],
    "servers": {
        "production": {
            "host": "user@example.com",
            "mappings": [
                {
                    "local": "/Users/dev/my-project",
                    "remote": "/var/www/html/api",
                    "excludes": ["node_modules", ".env"],
                    "artifact_excludes": ["*.tmp", "*.cache"]
                }
            ]
        }
    }
}
```

For full details on the underlying logic, see the [original script](https://github.com/Batyan45/wwsync).
