# Swift Development Instructions

This is a Swift project using the swift-agent-toolchain.

## Available tools

The `swift-toolchain` MCP server provides 21 tools for Swift development. Use these instead of raw shell commands:

- `swift_diagnostics` — SourceKit-LSP diagnostics (~1s). Use for the edit-verify loop.
- `swift_build` — incremental build with `stopAfter: typecheck` for fast validation.
- `swift_test` — structured test runner with filtering.
- `swift_verify` — staged verification cascade with automatic repair plan generation.
- `swift_repair_plan` / `swift_repair_next_step` — source-aware repair loops.
- `swift_behavior_verify` — regex-based pattern detection (24 patterns). Treat findings as hints.
- `swift_intent_check` — keyword-based intent matching. Not semantic.
- `swift_runtime_check` — simulator screenshot capture (no tap execution).
- `swift_xcode_info` — Xcode schemes, build settings, signing, destinations.
- `swift_package_search` — search Swift Package Index for dependencies.
- `swift_format` / `swift_lint` — code quality tools.

## Workflow

1. Run `swift_project_describe` first to understand the project.
2. After editing `.swift` files, run `swift_diagnostics` on changed files.
3. Run `swift_behavior_verify` on changed files (regex-based, may have false positives).
4. On failure, use `swift_verify` then follow the repair queue.
5. Run `swift_format` and `swift_lint` before finishing.

## Install toolchain (if not present)

```bash
git clone https://github.com/mameshivaa/swift-agent-toolchain.git .agents/plugins/swift-agent
cd .agents/plugins/swift-agent && npm run build
```
