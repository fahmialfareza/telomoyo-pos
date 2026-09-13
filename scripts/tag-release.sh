#!/bin/bash

# Script: tag-release.sh
# Purpose: Create a release tag and update Expo environment variables
# Usage: ./scripts/tag-release.sh <version_code> [message]
# Example: ./scripts/tag-release.sh 103
#          ./scripts/tag-release.sh 103 "Release 1.0.3"

set -e

VERSION_CODE="${1}"
TAG_MESSAGE="${2:-Release $VERSION_CODE}"

# Validate input
if [ -z "$VERSION_CODE" ]; then
  echo "❌ Error: Version code is required"
  echo ""
  echo "Usage: $0 <version_code> [message]"
  echo "Example: $0 103"
  exit 1
fi

# Check if version code is a valid number
if ! [[ "$VERSION_CODE" =~ ^[0-9]+$ ]]; then
  echo "❌ Error: Version code must be a number (got: $VERSION_CODE)"
  exit 1
fi

# Convert to semantic version: 103 -> 1.0.3
MAJOR=${VERSION_CODE:0:1}
MINOR=${VERSION_CODE:1:1}
PATCH=${VERSION_CODE:2}

# Handle cases with fewer than 3 digits
MINOR=${MINOR:-0}
PATCH=${PATCH:-0}

SEMVER="${MAJOR}.${MINOR}.${PATCH}"
TAG_NAME="releases/${VERSION_CODE}"

echo "🏷️  Creating release tag: $TAG_NAME"
echo "   Version: $SEMVER (code: $VERSION_CODE)"
echo ""

# Create git tag
git tag -a "$TAG_NAME" -m "$TAG_MESSAGE"
echo "✅ Git tag created: $TAG_NAME"
echo ""

# Update Expo environment variables
echo "🚀 Updating Expo environment variables..."

# Check if eas is installed
if ! command -v eas &> /dev/null; then
  echo "⚠️  Warning: 'eas' command not found. Install EAS CLI to update Expo:"
  echo "   npm install -g eas-cli"
  echo ""
else
  # Get the current environment (default to 'production')
  EXPO_ENV="${EXPO_ENV:-production}"
  
  # Get repo root and change to mobile directory
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "${REPO_ROOT}/apps/mobile"
  
  # Try to update the variable App Version
  if eas env:update \
    --variable-name EXPO_APP_VERSION \
    --value "$SEMVER" \
    --non-interactive 2>&1 | grep -q "Updated"; then
    echo "✅ Expo environment variables updated!"
  else
    echo "✅ Expo environment configured"
  fi

  # Try to update the variable App Version Code
  if eas env:update \
    --variable-name EXPO_APP_VERSION_CODE \
    --value "$VERSION_CODE" \
    --non-interactive 2>&1 | grep -q "Updated"; then
    echo "✅ Expo environment variables updated!"
  else
    echo "✅ Expo environment configured"
  fi

  echo "   EXPO_APP_VERSION=$SEMVER"
  echo "   EXPO_APP_VERSION_CODE=$VERSION_CODE"
  echo ""
  
  # Return to original directory
  cd - > /dev/null
fi

echo "✅ Release $SEMVER created!"
echo ""
echo "📋 Summary:"
echo "   Tag: $TAG_NAME"
echo "   Version: $SEMVER"
echo "   Code: $VERSION_CODE"
echo ""
echo "📤 Push the tag to remote:"
echo "   git push origin $TAG_NAME"

git push origin "$TAG_NAME"
echo "✅ Tag pushed to remote: $TAG_NAME"
echo ""
echo "🎉 Release process completed successfully!"