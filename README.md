# <img src="images/icon.png" width="64" align="center" alt="icon" /> WWSync for VSCode

A VSCode extension port of the [WWSync](https://github.com/Batyan45/wwsync) tool.

It allows you to synchronize your project with a remote server using `rsync` directly from VSCode, with safeguards against accidental deletions.

## Features

- **Safe Sync** ($(cloud-upload)): Uploads files without deleting anything on the remote server.
- **Full Sync** ($(sync)): Mirrors the local folder to the remote, deleting extra files (with confirmation).
- **Run** ($(terminal)): Opens an SSH session to the project folder.

## User Interface

WWSync provides two ways to interact with your servers:

1.  **Status Bar**:
    -   Displays the current connected server for the active file's directory (e.g. `WWSync: production`).
    -   Click the status bar item to open a **Reference Menu** where you can run sync commands or switch the default server for the session.
    -   The server list is filtered to only show servers configured for the current workspace folder.

2.  **Title Bar Buttons**:
    -   Quick access buttons in the editor title area for Safe Sync, Full Sync, and Run.

## Configuration

You can customize the extension appearance in VSCode Settings:

-   `wwsync.showButtons`: Show/hide the buttons in the editor title bar (default: `true`).
-   `wwsync.showStatusBar`: Show/hide the status bar item (default: `true`).

## Usage

1.  Open a folder in VSCode.
2.  Click the WWSync status bar item or title bar buttons to start.
3.  **Config**: The extension uses a `~/.wwsync` config file. It will prompt you to create it if missing, or add a new server/mapping if none exists for the current directory.

For full details on the underlying logic, see the [original script](https://github.com/Batyan45/wwsync).
