#!/usr/bin/env bash
# Usage: release-mobile.sh <platform> [version_code]
# platform: all | ios | android
# Example: release-mobile.sh all 211

set -euo pipefail

PLATFORM="${1:-all}"
VERSION_CODE="${2:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_PKG="${REPO_ROOT}/apps/mobile/package.json"

if [ -n "$VERSION_CODE" ]; then
  if ! [[ "$VERSION_CODE" =~ ^[0-9]+$ ]]; then
    echo "Error: version code must be a number (got: $VERSION_CODE)"
    exit 1
  fi

  MAJOR=${VERSION_CODE:0:1}
  MINOR=${VERSION_CODE:1:1}
  PATCH=${VERSION_CODE:2}
  MINOR=${MINOR:-0}
  PATCH=${PATCH:-0}
  SEMVER="${MAJOR}.${MINOR}.${PATCH}"

  echo "Bumping mobile version: $SEMVER (build $VERSION_CODE)"

  # Update apps/mobile/package.json
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('${MOBILE_PKG}', 'utf8'));
    p.version = '${SEMVER}';
    fs.writeFileSync('${MOBILE_PKG}', JSON.stringify(p, null, 2) + '\n');
  "

  # Update EAS cloud env vars
  cd "${REPO_ROOT}/apps/mobile"

  eas env:update \
    --variable-name EXPO_APP_VERSION \
    --value "$SEMVER" \
    --non-interactive

  eas env:update \
    --variable-name EXPO_APP_VERSION_CODE \
    --value "$VERSION_CODE" \
    --non-interactive

  cd "${REPO_ROOT}"

  git -C "${REPO_ROOT}" add apps/mobile/package.json
  if git -C "${REPO_ROOT}" diff --cached --quiet -- apps/mobile/package.json; then
    echo "No local version change to commit; continuing with release."
  else
    git -C "${REPO_ROOT}" commit -m "chore(mobile): bump version to ${SEMVER} (${VERSION_CODE})"
    git -C "${REPO_ROOT}" push origin main

    echo "Committed and pushed version bump to $SEMVER"
  fi
fi

cd "${REPO_ROOT}/apps/mobile"

# The shared workflow always builds and submits both platforms.
# Use direct EAS build + auto-submit for single-platform releases.
case "$PLATFORM" in
  all)
    # Run from the immutable commit that was pushed above. Without --ref, EAS
    # packages and uploads the entire local monorepo before starting a workflow.
    RELEASE_REF="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
    echo "Starting EAS workflow from commit: ${RELEASE_REF}"
    eas workflow:run .eas/workflows/create-production-builds.yml \
      --ref "$RELEASE_REF" \
      --non-interactive
    ;;
  ios|android)
    eas build --platform "$PLATFORM" --profile production --auto-submit
    ;;
  *)
    echo "Unknown platform: $PLATFORM (use all | ios | android)"
    exit 1
    ;;
esac
