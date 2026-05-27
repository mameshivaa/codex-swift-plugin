# Codex Swift Plugin

You have access to the `swift-toolchain` MCP server with 17 specialized Swift development tools. **Use these tools instead of raw shell commands** whenever you work on Swift code. They are faster, safer, and produce structured output you can act on directly.

## When to use this plugin

Use the swift-toolchain tools whenever you:
- Edit, create, or review `.swift` files
- Need to build, test, or diagnose a Swift/SwiftPM/Xcode project
- Search for Swift symbols or packages
- Work with SwiftUI Previews or simulators
- Fix compile errors or type-checker failures

## Tool selection guide

**Diagnosing problems** -- start here, not with `swift build` in a shell:
- `swift_diagnostics` -- SourceKit-LSP diagnostics in ~1s. Pass specific file paths for LSP mode. Pass empty array for full-project build-based diagnostics.
- `swift_verify` -- staged verification (diagnostics -> typecheck -> build -> test). Use after edits to confirm correctness at every level.

**Fixing problems:**
- `swift_repair_plan` -- feed a failed `swift_verify` result to get a source-aware repair plan with an execution queue.
- `swift_repair_next_step` -- step through the repair queue (inspect -> edit -> verify -> escalate).

**Building and testing:**
- `swift_build` -- incremental build. Use `stopAfter: "typecheck"` for fast cross-file type checking without full compilation.
- `swift_test` -- run tests with optional filter. Prefer this over `swift test` in shell because it returns structured pass/fail data.

**Code quality:**
- `swift_format` -- format with swift-format. Run on changed files after edits.
- `swift_lint` -- lint with SwiftLint. Run on changed files before committing.
- `swift_symbol_search` -- find type/func/var/protocol/enum definitions.

**Project understanding:**
- `swift_project_describe` -- call this first when entering a new project. Returns project type, targets, schemes, available tools, and config.
- `swift_xcode_info` -- Xcode schemes, build settings, signing identity, available destinations. Essential for iOS/macOS app projects.

**Dependencies:**
- `swift_package_search` -- search Swift Package Index. Better than guessing package names.
- `swift_package_resolve` -- resolve and verify dependencies after editing Package.swift.

**Preview and devices:**
- `swift_preview` -- detect and generate SwiftUI `#Preview` blocks.
- `swift_simulator_list` / `swift_simulator_run` -- list and run on simulators.
- `swift_device_list` -- list connected physical devices.

## Verification order (fastest feedback first)

After every Swift file edit, verify in this order. Stop at the first failure and fix it before proceeding:

1. `swift_diagnostics` with specific files (SourceKit-LSP, ~1s)
2. `swift_build` with `stopAfter: "typecheck"` (cross-file, ~seconds)
3. `swift_build` (full compile)
4. `swift_test` (runtime correctness)
5. `swift_preview` / `swift_simulator_run` (visual/runtime)

Or use `swift_verify` which runs this cascade automatically and returns a repair plan on failure.

## Rules

- **Never run raw `swift build` or `swift test` in a shell** when these MCP tools are available. The tools provide structured output, error locations, and actionable suggestions.
- **Always call `swift_project_describe` first** when you enter an unfamiliar Swift project. It tells you what tools are available and how the project is configured.
- **Use `swift_diagnostics` for the edit-verify loop**, not full builds. LSP mode is 10x faster than a full build for single-file changes.
- **Follow the repair queue** when `swift_verify` fails. The queue tells you exactly what to inspect, edit, and verify.
- **Run `swift_format` and `swift_lint` on changed files** before presenting results to the user.
