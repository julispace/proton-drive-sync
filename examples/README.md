# Proton Drive File Listing Example

A CLI tool to list all files in your Proton Drive using the `@protontech/drive-sdk`.

## Installation

```bash
pnpm install
```

This installs:
- `@protontech/drive-sdk` - Local SDK from `../sdk/js/sdk`
- `openpgp` - OpenPGP.js for cryptographic operations
- `bcryptjs` - For SRP password hashing

## Usage

```bash
node list-files.js [options]
```

The script will prompt for your Proton username and password interactively.

### Options

| Option | Description |
|--------|-------------|
| `-h, --help` | Show help message |
| `-u, --username <user>` | Proton username (will prompt if not provided) |
| `-p, --password <pass>` | Password (will prompt if not provided) |
| `--no-my-files` | Skip listing files in "My Files" |
| `--no-shared` | Skip listing shared files |
| `--no-trash` | Skip listing trashed files |
| `--json` | Output as JSON instead of formatted text |

### Examples

```bash
# Interactive login (most secure)
node list-files.js

# Provide username, prompt for password
node list-files.js -u myusername

# List only My Files and Shared (skip Trash)
node list-files.js --no-trash

# Output as JSON for programmatic use
node list-files.js --json

# Show help
node list-files.js --help
```

Or use the pnpm script:
```bash
pnpm list-files
```

## Security Notes

- **Avoid passing password via command line** - The interactive prompt is more secure as passwords passed via `-p` may be visible in shell history.
- **Session is not persisted** - Each run requires re-authentication.
- **2FA is supported** - If your account has 2FA enabled, you'll be prompted for the code.

## Sample Output

```
Authenticating with Proton...
Starting authentication...
Getting auth info...
Performing SRP authentication...
Authenticating...
Decrypting user keys...
Fetching user data...
Authentication successful!
Logged in as: myusername

Fetching My Files...
Fetching shared files...
Fetching trash...

Proton Drive Files
==================

=== My Files ===

[FOLDER]   Documents/
[FILE]     Documents/report.pdf (2.45 MB, modified: 2024-01-15T10:30:00.000Z)
[FILE]     Documents/notes.txt (1.23 KB, modified: 2024-01-14T08:15:00.000Z)
[FOLDER]   Photos/
[FILE]     Photos/vacation.jpg (3.67 MB, modified: 2024-01-10T14:22:00.000Z)

=== Shared with me ===

[FILE]     shared-document.docx (456.00 KB, modified: 2024-01-12T09:00:00.000Z)

=== Trash ===

[FILE]     old-file.txt (trashed: 2024-01-13T16:45:00.000Z)

---
Total: 4 files, 2 folders, 1 trashed items
```

## How It Works

1. **Authentication**: Uses Proton's SRP (Secure Remote Password) protocol to securely authenticate without sending the password to the server.

2. **Key Decryption**: After login, decrypts the user's private keys using bcrypt-derived key password.

3. **SDK Integration**: Creates an authenticated HTTP client and account provider that implement the interfaces required by `@protontech/drive-sdk`.

4. **File Listing**: Uses the SDK's async iterators to traverse folders and list files.

## Architecture

```
examples/
├── list-files.js          # Main CLI script
├── auth/
│   ├── index.js           # Auth module exports
│   ├── protonAuth.js      # Main auth class (login flow)
│   ├── srp.js             # SRP protocol implementation
│   ├── session.js         # Session management
│   ├── httpClient.js      # Authenticated HTTP client
│   ├── account.js         # Account provider for SDK
│   └── crypto.js          # Crypto utilities
├── package.json
└── README.md
```

## Troubleshooting

### "Error: Could not load @protontech/drive-sdk"

The SDK needs to be built first:
```bash
cd ../sdk/js/sdk
pnpm install
pnpm build
```

### "Server proof verification failed"

This indicates a possible man-in-the-middle attack or network issue. Try again on a trusted network.

### "Two-factor authentication required"

If your account has 2FA enabled, you'll be prompted for the TOTP code. FIDO2/WebAuthn is not currently supported in this CLI.

### "Failed to decrypt user key"

This may occur if:
- The password is incorrect
- The account uses an older authentication version
- There are organization-managed keys that require additional decryption

## Limitations

- **FIDO2/WebAuthn not supported** - Only TOTP 2FA works in CLI
- **Organization keys** - May not fully support organization-managed accounts
- **Legacy auth versions** - Only auth version 3+ is fully supported

## References

- [Proton Drive SDK Source](../sdk/js/sdk/)
- [Proton WebClients](https://github.com/ProtonMail/WebClients) - Reference implementation
- [pmcrypto](https://github.com/ProtonMail/pmcrypto) - Proton's crypto library
