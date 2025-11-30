# Proton Drive Sync

A CLI tool that watches local directories and syncs changes to Proton Drive in real-time using Facebook's Watchman.

## Getting Started

### Requirements

- Node.js >= 18
- [Watchman](https://facebook.github.io/watchman/docs/install)

### Installation

```bash
npm install -g proton-drive-sync
```

### Authentication

```bash
proton-drive-sync auth
```

### Set Up Service (Optional)

This installs both Watchman and proton-drive-sync as launchd services that start automatically on boot:

```bash
# Install the service
proton-drive-sync service install

# Uninstall the service
proton-drive-sync service uninstall
```

### Configuration

Run the config command to create and edit your config file:

```bash
proton-drive-sync config
```

This opens the config file at `~/.config/proton-drive-sync/config.json`:

```json
{
    "sync_dirs": ["/path/to/first/directory", "/path/to/second/directory"],
    "remote_root": "backups"
}
```

| Field         | Required | Description                                        |
| ------------- | -------- | -------------------------------------------------- |
| `sync_dirs`   | Yes      | Array of local directories to sync                 |
| `remote_root` | No       | Remote folder prefix in Proton Drive (default: "") |

Each directory in `sync_dirs` will be watched and synced to Proton Drive. Files are uploaded to a folder named after the directory basename (e.g., `/Users/me/Documents` syncs to `Documents/` in Proton Drive, or `backups/Documents/` if `remote_root` is set).

## Other CLI Usage

Apart from running as a service, this tool can be used as a CLI program:

```bash
# One-time sync
proton-drive-sync sync

# Watch for changes continuously (Ctrl+C to stop)
proton-drive-sync sync --watch

# Verbose output
proton-drive-sync sync -v

# Dry run (show what would sync without making changes)
proton-drive-sync sync --dry-run

# Show help
proton-drive-sync --help
```

## Development

```bash
git clone https://github.com/damianb-bitflipper/proton-drive-sync
cd proton-drive-sync
pnpm install
pnpm link --global
```

Run directly with `pnpm tsx` (no build step required):

```bash
pnpm tsx src/index.ts sync
```

Or rebuild after changes:

```bash
pnpm build
proton-drive-sync sync
```

## Publishing

To publish a new version to npm:

```bash
# Login to npm (if not already logged in)
pnpm login

# Build the package
pnpm build

# Publish to npm
pnpm publish
```
