# Swift Development Instructions

This is a Swift project. Use the codex-swift plugin tools for all Swift development tasks.

## Setup

If the `swift-toolchain` MCP server is not available, install the plugin:

```bash
git clone https://github.com/mameshivaa/codex-swift-plugin.git .agents/plugins/codex-swift
cd .agents/plugins/codex-swift && npm run build
```

## Workflow

1. **First**: Run `swift_project_describe` to understand the project structure.
2. **Editing**: After every `.swift` file edit, run `swift_diagnostics` on the changed files.
3. **Fixing**: If diagnostics fail, use `swift_verify` then `swift_repair_plan` to get a structured fix plan.
4. **Testing**: Run `swift_test` after fixes. Write tests with Swift Testing (`@Test` macro).
5. **Quality**: Run `swift_format` and `swift_lint` on changed files before finishing.

## Rules

- Use `swift_diagnostics` (SourceKit-LSP, ~1s) instead of running `swift build` in a shell.
- Use `swift_build --stop-after typecheck` for fast cross-file validation.
- Use `swift_package_search` to find packages instead of guessing names.
- Use `swift_xcode_info` for Xcode project details (schemes, signing, destinations).
- Follow the repair execution queue from `swift_repair_plan` when fixing build errors.
