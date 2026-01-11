#!/usr/bin/env bash
#
# Generate AUR PKGBUILD from template
#
# Required environment variables:
#   VERSION       - Version string (e.g., "0.2.2-beta.2")
#   PACKAGE_NAME  - AUR package name (e.g., "proton-drive-sync-prerelease-bin")
#   ARTIFACTS_DIR - Directory containing the Linux tarballs
#
# Output: PKGBUILD file in current directory

set -euo pipefail

# Validate required environment variables
: "${VERSION:?VERSION is required}"
: "${PACKAGE_NAME:?PACKAGE_NAME is required}"
: "${ARTIFACTS_DIR:?ARTIFACTS_DIR is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_PATH="${SCRIPT_DIR}/../aur/PKGBUILD.template"

# Convert version for AUR (remove hyphens, e.g., "0.2.2-beta.2" -> "0.2.2beta.2")
AUR_VERSION="${VERSION//-/}"

# Compute SHA256 checksums
SHA256_X64=$(sha256sum "${ARTIFACTS_DIR}/proton-drive-sync-linux-x64.tar.gz" | cut -d' ' -f1)
SHA256_ARM64=$(sha256sum "${ARTIFACTS_DIR}/proton-drive-sync-linux-arm64.tar.gz" | cut -d' ' -f1)

echo "Generating PKGBUILD for ${PACKAGE_NAME} v${VERSION} (AUR version: ${AUR_VERSION})"
echo "  SHA256 x64:   ${SHA256_X64}"
echo "  SHA256 arm64: ${SHA256_ARM64}"

# Generate PKGBUILD from template
sed -e "s|{{PACKAGE_NAME}}|${PACKAGE_NAME}|g" \
	-e "s|{{VERSION}}|${AUR_VERSION}|g" \
	-e "s|{{VERSION_ORIGINAL}}|${VERSION}|g" \
	-e "s|{{SHA256_X64}}|${SHA256_X64}|g" \
	-e "s|{{SHA256_ARM64}}|${SHA256_ARM64}|g" \
	"${TEMPLATE_PATH}" >PKGBUILD

echo "Generated PKGBUILD successfully"
