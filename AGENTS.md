# Swift Agent Toolchain

You have access to the `swift-toolchain` MCP server with 21 specialized Swift development tools. **Use these tools instead of raw shell commands** whenever you work on Swift code. They are faster, safer, and produce structured output you can act on directly.

## When to use this toolchain

Use the swift-toolchain tools whenever you:
- Edit, create, or review `.swift` files
- Need to build, test, or diagnose a Swift/SwiftPM/Xcode project
- Search for Swift symbols or packages
- Work with SwiftUI Previews or simulators
- Fix compile errors or type-checker failures

## Tool selection guide

**Diagnosing problems** — start here, not with `swift build` in a shell:
- `swift_diagnostics` — SourceKit-LSP diagnostics in ~1s. Pass specific file paths for LSP mode. Pass empty array for full-project build-based diagnostics.
- `swift_behavior_verify` — regex-based pattern detection (24 patterns): empty button actions, unused @State, missing @Published, broken navigation, placeholder data, deprecated patterns, Bool flag clusters, stale async. **Note:** regex-based, not AST — expect false positives on complex code.
- `swift_deep_verify` — architectural pattern detection for AVFoundation/ScreenCaptureKit/CoreMedia projects. Only useful for media/capture apps.
- `swift_intent_check` — keyword-based check that code matches stated intent. Pass the user's request as natural language. **Note:** matches keywords, not semantic meaning.
- `swift_verify` — staged verification (diagnostics → typecheck → build → test). Use after edits to confirm correctness at every level.

**Visual verification:**
- `swift_runtime_check` — build, launch on simulator, capture screenshot. **Note:** screenshot only; does not execute tap sequences.

**Fixing problems:**
- `swift_repair_plan` — feed a failed `swift_verify` result to get a source-aware repair plan with an execution queue.
- `swift_repair_next_step` — step through the repair queue (inspect → edit → verify → escalate).

**Building and testing:**
- `swift_build` — incremental build. Use `stopAfter: "typecheck"` for fast cross-file type checking without full compilation.
- `swift_test` — run tests with optional filter. Prefer this over `swift test` in shell because it returns structured pass/fail data.

**Code quality:**
- `swift_format` — format with swift-format. Run on changed files after edits.
- `swift_lint` — lint with SwiftLint. Run on changed files before committing.
- `swift_symbol_search` — find type/func/var/protocol/enum definitions.

**Project understanding:**
- `swift_project_describe` — call this first when entering a new project. Returns project type, targets, schemes, available tools, and config.
- `swift_xcode_info` — Xcode schemes, build settings, signing identity, available destinations. Essential for iOS/macOS app projects.

**Dependencies:**
- `swift_package_search` — search Swift Package Index. Better than guessing package names.
- `swift_package_resolve` — resolve and verify dependencies after editing Package.swift.

**Preview and devices:**
- `swift_preview` — detect and generate SwiftUI `#Preview` blocks.
- `swift_simulator_list` / `swift_simulator_run` — list and run on simulators.
- `swift_device_list` — list connected physical devices.

## Verification order (fastest feedback first)

After every Swift file edit, run checks in this order:

1. `swift_diagnostics` with specific files (SourceKit-LSP, ~1s) — **does it compile?**
2. `swift_behavior_verify` on changed files — **obvious pattern bugs?** (regex-based, may have false positives)
3. `swift_intent_check` with the user's request — **right keywords present?** (not semantic understanding)

Then, as needed:
4. `swift_build` with `stopAfter: "typecheck"` (cross-file, ~seconds)
5. `swift_build` (full compile)
6. `swift_test` (runtime correctness)
7. `swift_runtime_check` (screenshot from simulator — manual review needed)

Or use `swift_verify` which runs the build cascade automatically and returns a repair plan on failure.

## Rules

- **Never run raw `swift build` or `swift test` in a shell** when these MCP tools are available.
- **Always call `swift_project_describe` first** when you enter an unfamiliar Swift project.
- **Use `swift_diagnostics` for the edit-verify loop**, not full builds.
- **Run `swift_behavior_verify` after generating code** — compiling is not enough. But treat findings as hints, not definitive bugs (regex-based detection).
- **Run `swift_deep_verify` only on media/recording/capture projects** — it's domain-specific.
- **Run `swift_intent_check` before presenting results** — but note it checks for keywords, not meaning.
- **Follow the repair queue** when `swift_verify` fails.
- **Run `swift_format` and `swift_lint` on changed files** before presenting results.
- **Use `swift_runtime_check`** when the user asks to see the app — but review the screenshot yourself, as it only captures, not interacts.
