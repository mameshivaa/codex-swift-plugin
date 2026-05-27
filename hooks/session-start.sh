#!/usr/bin/env bash
# Detect Swift project type and inject context at session start.
set -euo pipefail

# Codex sends hook input as JSON on stdin; extract cwd from it.
HOOK_INPUT=$(cat)
PROJECT_ROOT=$(echo "$HOOK_INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null)
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
CONTEXT=""

# Detect project kind
if [ -f "$PROJECT_ROOT/Package.swift" ]; then
  SWIFT_VERSION=$(swift --version 2>/dev/null | head -1 || echo "unknown")
  PKG_NAME=$(grep -m1 'name:' "$PROJECT_ROOT/Package.swift" | sed 's/.*name:[[:space:]]*"\([^"]*\)".*/\1/' || echo "unknown")
  TARGETS=$(grep '\.target\|\.executableTarget\|\.testTarget' "$PROJECT_ROOT/Package.swift" | sed 's/.*name:[[:space:]]*"\([^"]*\)".*/  - \1/' | head -10 || echo "  (none detected)")
  CONTEXT="Swift project detected: **${PKG_NAME}** (SwiftPM)
Toolchain: ${SWIFT_VERSION}
Targets:
${TARGETS}

Use the swift-explore skill for prototyping, swift-fix for build errors, and swift-test for testing."
elif ls "$PROJECT_ROOT"/*.xcodeproj &>/dev/null || ls "$PROJECT_ROOT"/*.xcworkspace &>/dev/null; then
  XCODE_PROJ=$(ls -d "$PROJECT_ROOT"/*.xcworkspace 2>/dev/null | head -1 || ls -d "$PROJECT_ROOT"/*.xcodeproj 2>/dev/null | head -1)
  PROJ_NAME=$(basename "$XCODE_PROJ" | sed 's/\.\(xcodeproj\|xcworkspace\)$//')
  SWIFT_VERSION=$(swift --version 2>/dev/null | head -1 || echo "unknown")
  CONTEXT="Swift project detected: **${PROJ_NAME}** (Xcode project)
Toolchain: ${SWIFT_VERSION}

Use the swift-explore skill for prototyping, swift-fix for build errors, and swift-review for PR reviews."
else
  # Not a Swift project — exit silently
  exit 0
fi

# Output context for the session (use python3 for safe JSON escaping)
python3 -c "
import json, sys
print(json.dumps({'additionalContext': sys.stdin.read().strip()}))
" <<EOF
${CONTEXT}
EOF
