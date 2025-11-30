# Proton Drive Sync

A CLI tool that watches local directories and syncs changes to Proton Drive in real-time using Facebook's Watchman.

## Requirements

- [pnpm](https://pnpm.io/installation)
- [Watchman](https://facebook.github.io/watchman/docs/install) - `brew install watchman` on macOS

## Installation

```bash
git clone https://github.com/user/proton-drive-sync
cd proton-drive-sync
pnpm install
pnpm build
pnpm link --global
```

## Configuration

Create a config file at `~/.config/proton-drive-sync/config.json`:

```json
{
    "sync_dirs": ["/path/to/first/directory", "/path/to/second/directory"]
}
```

Each directory in `sync_dirs` will be watched and synced to Proton Drive. Files are uploaded to a folder named after the directory basename (e.g., `/Users/me/Documents` syncs to `Documents/` in Proton Drive).

## Usage

```bash
# Authenticate (first time only)
proton-drive-sync auth

# Start syncing
proton-drive-sync sync

# Verbose output
proton-drive-sync sync -v

# Dry run (show what would sync without making changes)
proton-drive-sync sync --dry-run

# Show help
proton-drive-sync --help
```

This will:

1. Watch all configured directories for changes
2. Automatically sync file/directory creates, updates, and deletes to Proton Drive

Press `Ctrl+C` to stop watching.

## Development

For an editable install (changes to source are reflected immediately):

```bash
pnpm install
pnpm link --global
```

Then run directly with `pnpm tsx` (no build step required):

```bash
pnpm tsx src/index.ts sync
```

Or rebuild after changes:

```bash
pnpm build
proton-drive-sync sync
```
