#!/usr/bin/env bash
# Clear quarantine extended attributes on a downloaded macOS DMG.
# See Releases.md (xattr -cr ...) for context.
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <path-to.dmg>" >&2
  exit 1
fi
xattr -cr "$1"
