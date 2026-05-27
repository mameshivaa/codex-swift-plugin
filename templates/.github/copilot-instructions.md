# Swift Development Instructions

This is a Swift project using the codex-swift plugin for toolchain integration.

## Available MCP tools

When the `swift-toolchain` MCP server is available, prefer these over shell commands:

- `swift_diagnostics` -- SourceKit-LSP diagnostics in ~1s. Faster than full builds for single-file edits.
- `swift_build` -- incremental build. Use `stopAfter: typecheck` for fast cross-file validation.
- `swift_test` -- structured test runner with pass/fail data.
- `swift_verify` -- staged verification cascade with repair plan output.
- `swift_xcode_info` -- Xcode schemes, build settings, signing, destinations.
- `swift_package_search` -- search Swift Package Index.
- `swift_format` / `swift_lint` -- code quality.

## Workflow

1. `swift_project_describe` first to understand the project.
2. After `.swift` edits, `swift_diagnostics` on changed files.
3. On failure, `swift_verify` then follow the repair queue.
4. `swift_format` + `swift_lint` before finishing.

## Plugin install

```bash
git clone https://github.com/mameshivaa/codex-swift-plugin.git .agents/plugins/codex-swift
cd .agents/plugins/codex-swift && npm run build
```
