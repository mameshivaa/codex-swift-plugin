# Swift Development Instructions

This is a Swift project using the swift-agent-toolchain for development acceleration.

## Available MCP tools

When the `swift-toolchain` MCP server is available, prefer these over shell commands:

- `swift_diagnostics` — SourceKit-LSP diagnostics in ~1s. Faster than full builds for single-file edits.
- `swift_build` — incremental build. Use `stopAfter: typecheck` for fast cross-file validation.
- `swift_test` — structured test runner with pass/fail data.
- `swift_verify` — staged verification cascade with repair plan output.
- `swift_behavior_verify` — regex-based pattern detection (24 patterns). Treat as hints.
- `swift_xcode_info` — Xcode schemes, build settings, signing, destinations.
- `swift_package_search` — search Swift Package Index.
- `swift_format` / `swift_lint` — code quality.

## Workflow

1. `swift_project_describe` first to understand the project.
2. After `.swift` edits, `swift_diagnostics` on changed files.
3. `swift_behavior_verify` on changed files (regex-based hints).
4. On failure, `swift_verify` then follow the repair queue.
5. `swift_format` + `swift_lint` before finishing.

## Install toolchain

```bash
git clone https://github.com/mameshivaa/swift-agent-toolchain.git .agents/plugins/swift-agent
cd .agents/plugins/swift-agent && npm run build
```
