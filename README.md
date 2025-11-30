# Proton Drive Sync

A CLI tool that watches a local directory and syncs changes to Proton Drive in real-time using Facebook's Watchman.

## Requirements

- [pnpm](https://pnpm.io/installation)
- [Watchman](https://facebook.github.io/watchman/docs/install) - `brew install watchman` on macOS

## Setup

```bash
git submodule update --init --recursive
pnpm install
```

## Run

```bash
pnpm sync
```

This will:

1. Prompt for your Proton credentials (with optional 2FA)
2. Save credentials to your macOS Keychain for future use
3. Watch the `my_files/` directory for changes
4. Automatically sync file/directory creates, updates, and deletes to Proton Drive

Press `Ctrl+C` to stop watching.
