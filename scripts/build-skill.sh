#!/usr/bin/env bash
# Build the xmind skill package into build/xmind-skill.zip
# Usage: bash scripts/build-skill.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="$REPO_ROOT/skills/xmind"
BUILD_DIR="$REPO_ROOT/build"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$BUILD_DIR"
rm -f "$BUILD_DIR/xmind-skill.zip"

# Stage the skill under xmind/ (so unzip creates the right folder) together with the licence.
mkdir -p "$STAGE/xmind/scripts/lib" "$STAGE/xmind/references"
cp "$SKILL_DIR/SKILL.md" "$STAGE/xmind/"
cp "$SKILL_DIR/scripts/create_xmind.mjs" \
   "$SKILL_DIR/scripts/read_xmind.mjs" \
   "$SKILL_DIR/scripts/preview_xmind.py" "$STAGE/xmind/scripts/"
cp "$SKILL_DIR"/scripts/lib/*.mjs "$STAGE/xmind/scripts/lib/"
cp "$SKILL_DIR"/references/*.md "$STAGE/xmind/references/"
cp "$REPO_ROOT/LICENSE" "$STAGE/xmind/LICENSE"

(cd "$STAGE" && zip -r -q "$BUILD_DIR/xmind-skill.zip" xmind)

echo "Built: $BUILD_DIR/xmind-skill.zip"
unzip -l "$BUILD_DIR/xmind-skill.zip"
echo ""
echo "Install (Claude Code):    unzip -o $BUILD_DIR/xmind-skill.zip -d ~/.claude/skills/"
echo "Install (Claude Desktop): Settings → Capabilities → Skills → upload the zip"
