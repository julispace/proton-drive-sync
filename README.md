# Proton Drive Sync

A CLI tool to list files in your Proton Drive.

## Requirements

- [pnpm](https://pnpm.io/installation)

## Setup

```bash
git submodule update --init --recursive
pnpm install
```

## Run

```bash
pnpm tsx src/list-files.ts
```

Credentials are saved to your macOS Keychain after first login.
