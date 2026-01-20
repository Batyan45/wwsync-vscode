# WWSync for VSCode

A VSCode extension port of the [WWSync](https://github.com/Batyan45/wwsync) tool.

It allows you to synchronize your project with a remote server using `rsync` directly from VSCode, with safeguards against accidental deletions.

## Features

- **Safe Sync** ($(cloud-upload)): Uploads files without deleting anything on the remote server.
- **Full Sync** ($(sync)): Mirrors the local folder to the remote, deleting extra files (with confirmation).
- **Run** ($(terminal)): Opens an SSH session to the project folder.

## Usage

1. **Buttons**: Use the buttons in the editor title bar.
2. **Commands**: Access via command palette (`Ctrl+Shift+P` -> `WWSync: ...`).
3. **Config**: Uses `~/.wwsync`. The extension will prompt to create it if missing, or if a new server/mapping is needed.

For full details on the underlying logic, see the [original script](https://github.com/Batyan45/wwsync).
