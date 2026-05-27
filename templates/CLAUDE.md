# Swift Development Instructions

This is a Swift project. Use the swift-agent-toolchain MCP tools for all Swift development tasks.

## Setup

If the `swift-toolchain` MCP server is not available, install the toolchain:

```bash
git clone https://github.com/mameshivaa/swift-agent-toolchain.git .agents/plugins/swift-agent
cd .agents/plugins/swift-agent && npm run build
```

## Workflow

1. **First**: Run `swift_project_describe` to understand the project structure.
2. **After every edit, check**:
   - `swift_diagnostics` — does it compile?
   - `swift_behavior_verify` — obvious pattern bugs? (regex-based, treat findings as hints)
   - `swift_intent_check` with the user's request — right keywords present? (not semantic)
3. **Fixing**: If diagnostics fail, use `swift_verify` then `swift_repair_plan`.
4. **Visual check**: Use `swift_runtime_check` to launch on simulator and capture a screenshot (screenshot only, no tap interaction).
5. **Quality**: Run `swift_format` and `swift_lint` before finishing.

## Rules

- Use `swift_diagnostics` (SourceKit-LSP, ~1s) instead of running `swift build` in a shell.
- **Run `swift_behavior_verify` after generating code** — but treat results as hints, not definitive bugs (regex-based).
- **Run `swift_intent_check` before presenting results** — checks for keywords, not meaning.
- Use `swift_package_search` to find packages instead of guessing names.
- Use `swift_xcode_info` for Xcode project details.
