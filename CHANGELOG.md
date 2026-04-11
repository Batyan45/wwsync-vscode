# Change Log

All notable changes to the "WWSync" extension will be documented in this file.

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
