# Change Log

All notable changes to the "WWSync" extension will be documented in this file.

## [1.3.0] - 2026-11-07

### Added
- **Remote Files panel**: new WWSync icon in the Activity Bar. **Open Remote Folder** opens the same remote folder that Safe Sync uses for the current folder (the status bar server and its mapping's remote path, never the home folder); showing the panel alone does not connect. While connected, it follows server changes made in the status bar.
- Remote files open in regular VS Code editors through the new `wwsync://<server>/<path>` file system and are saved back to the server with `Ctrl+S`. Remote tabs are restored after a restart.
- File operations in the panel: New File/Folder, Rename (`F2`), Delete (`Delete`, multi-select), Copy Path / Copy Relative Path, Open in Remote Terminal, Go to Parent Folder / Go to This Folder / Go to Project Folder, Switch Server (among the servers mapped to the folder).
- **Compare with Local**: diff of a remote file and its copy in the local project, from the panel or from a remote editor tab.
- `WWSync: Browse Remote Files` command, also available in the status bar menu.
- Uses one persistent SFTP session per server via the system `ssh`, with the same password/passphrase prompts and session cache as sync. Does not need `rsync`.

### Fixed
- Reopening Browse Remote Files returns to the current workspace's configured remote folder, including after navigating to a parent folder or editing the mapping.
- Local mapping selection and Compare with Local preserve path case on Linux/WSL; differently cased project folders no longer share mappings or the sync busy guard.
- Full Sync quotes the remote path in `rm -rf` / `mkdir -p` (a leading `~/` still expands), so a path with spaces can no longer make it delete other folders.
- Cancelling a sync or download is no longer reported as an error, and it now also stops the `ssh` process started by rsync before the operation ends.
- A second sync or download for the same folder no longer starts while one is still running.
- Error notifications show the actual cause (for example `ssh: Could not resolve hostname ...`) instead of only "failed with code 255", with a **Show Output** button. A failure shows one notification instead of two.
- A clear message when `rsync` is not installed.
- A password prompt left open by a cancelled operation is closed.
- The VSIX package no longer includes the bundled Python CLI (`wwsync/` folder).

## [1.2.0] - 2026-07-07

### Changed
- New extension icon.

## [1.1.0] - 2026-04-08

### Added
- Added support for `general_excludes` in the `.wwsync` config file. This allows you to define global exclusion patterns (like `.git` and `.DS_Store`) that apply across all servers and mappings.

### Changed
- Changed `--full` sync operation logic to match the upstream Python project: the remote directory is now entirely recreated (`ssh rm -rf && mkdir -p`) before uploading all files, replacing the previous incremental `rsync --delete` approach to guarantee a clean state.


## [1.0.1] - 2026-04-08

### Fixed
- Fixed rsync commands failing with `Unexpected remote arg` error for hosts containing `:` in path (e.g. `host:/remote/path`). Removed `shell: true` from `cp.spawn` to prevent shell interpretation of arguments.

## [1.0.0] - 2026-02-18

### Added
- **Artifacts Download command**: Added `Download Artifacts` action (`wwsync.downloadArtifacts`) in command palette, editor title buttons, and status bar quick menu.
- Added support for `artifact_excludes` in mapping config.
- Added `artifact_excludes` setup prompt when creating a new mapping.

### Changed
- Implemented remote artifacts flow aligned with upstream Python project:
- downloads only **new** remote files into `.wwsync_<server>_artifacts`
- shows warning list for **changed** remote files and skips them
- asks confirmation before deleting/recreating existing artifacts folder
- Updated README with artifacts feature description and config example.

## [0.1.3] - 2026-02-15

### Changed
- Added `--force` flag to Full Sync mode to ensure deletion of non-empty directories on remote.
- Improved output formatting for deleted files in Full Sync dry run.

## [0.1.2] - 2026-01-24

### Added
- **Password/Passphrase Handling**: Added support for interactive password and key passphrase entry during sync.
- **Credential Caching**: Entered passwords are remembered for the duration of the current session to avoid repeated prompts.
- Added ability to cancel sync process.

## [0.1.1] - 2026-01-22

### Changed
- Automatically select server if it is the only one configured for the current folder.
- Replaced persistent success popup with a transient status bar message.
- Added progress indicator notification during synchronization.

## [0.1.0] - 2026-01-21

### Added
- **Status Bar Integration**: New status bar item showing current server.
- **Quick Menu**: Click status bar to access sync actions and switch servers.
- **Session Memory**: Server selections are remembered per-folder execution.

## [0.0.3] - 2026-01-21

### Added
- Extension icon.

### Changed
- Improved deletion confirmation message in "full sync".

### Fixed
- File path parsing in deleted files list.

## [0.0.2] - 2026-01-20

### Added
- License text (`LICENSE.md`)
- Change log (`CHANGELOG.md`)

## [0.0.1] - 2026-01-20

### Added
- Initial commit
