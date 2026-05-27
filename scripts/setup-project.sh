#!/usr/bin/env bash
# Setup codex-swift agent instructions in a Swift project.
# Usage: bash setup-project.sh [project-dir]
#
# Creates agent instruction files so that AI coding agents
# (Codex, Claude Code, Cursor, GitHub Copilot, Cline)
# automatically use the codex-swift plugin tools.

set -euo pipefail

PROJECT_DIR="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES="$PLUGIN_ROOT/templates"

cd "$PROJECT_DIR"

echo "Setting up codex-swift agent instructions in: $(pwd)"

# CLAUDE.md (Claude Code)
if [ ! -f "CLAUDE.md" ]; then
  cp "$TEMPLATES/CLAUDE.md" CLAUDE.md
  echo "  Created CLAUDE.md"
else
  echo "  CLAUDE.md already exists, skipping"
fi

# .codex/instructions.md (Codex)
mkdir -p .codex
if [ ! -f ".codex/instructions.md" ]; then
  cp "$TEMPLATES/codex-instructions.md" .codex/instructions.md
  echo "  Created .codex/instructions.md"
else
  echo "  .codex/instructions.md already exists, skipping"
fi

# .cursorrules (Cursor)
if [ ! -f ".cursorrules" ]; then
  cp "$TEMPLATES/.cursorrules" .cursorrules
  echo "  Created .cursorrules"
else
  echo "  .cursorrules already exists, skipping"
fi

# .github/copilot-instructions.md (GitHub Copilot)
mkdir -p .github
if [ ! -f ".github/copilot-instructions.md" ]; then
  cp "$TEMPLATES/.github/copilot-instructions.md" .github/copilot-instructions.md
  echo "  Created .github/copilot-instructions.md"
else
  echo "  .github/copilot-instructions.md already exists, skipping"
fi

# .codex-swift.json (plugin config)
if [ ! -f ".codex-swift.json" ]; then
  cat > .codex-swift.json << 'JSON'
{
  "excludePaths": ["DerivedData", ".build"],
  "timeouts": {
    "build": 180000,
    "test": 120000
  }
}
JSON
  echo "  Created .codex-swift.json"
else
  echo "  .codex-swift.json already exists, skipping"
fi

echo ""
echo "Done. AI agents will now use codex-swift tools when working on this project."
echo ""
echo "Files created:"
echo "  CLAUDE.md              -- Claude Code"
echo "  .codex/instructions.md -- Codex"
echo "  .cursorrules           -- Cursor"
echo "  .github/copilot-instructions.md -- GitHub Copilot"
echo "  .codex-swift.json      -- Plugin config"
